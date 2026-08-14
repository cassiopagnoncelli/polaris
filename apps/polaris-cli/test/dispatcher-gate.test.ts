/**
 * Dispatcher-level tests for the P6-007 production-mutation gate.
 *
 * These tests drive the real `run()` entry point with synthetic command
 * definitions and a synthetic operator-token repository, so the assertions
 * exercise the actual `enforceProductionMutationGate` + `resolveActor` glue
 * inside `program.ts` rather than calling the gate in isolation.
 *
 * The gate's matrix is covered by
 * `packages/shared-control-plane/test/gate.test.ts` (pure function).
 * Here we prove the wiring:
 *
 *   - the dispatcher reads `--env` and `POLARIS_ENV` correctly,
 *   - the dispatcher refuses with exit code 2 (usage error class) on
 *     production-without-token,
 *   - the dispatcher passes the resolved actor through `ctx.actor` so
 *     commands stamp `actor_source` and `actor_label` on their audit rows,
 *   - a valid `POLARIS_OPERATOR_TOKEN` flips the actor to `operator_token` and
 *     the gate allows the run.
 */

import type {
  OperatorTokenRepository,
  OperatorTokenRow,
  ResolvedActor,
} from "@polaris/shared-control-plane";
import { POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandContext,
  type CommandDefinition,
  ExitCode,
  type OutputStreams,
  type PackageMeta,
  run,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  releaseLabel: undefined,
  nodeVersion: "v22.0.0",
};

const VALID_ENV = {
  POLARIS_API_URL: "https://polaris.example.internal",
  POLARIS_TOKEN: "polaris_ot_test",
} as const;

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

/**
 * Synthetic command that records the actor it observed on `ctx.actor`.
 *
 * The dispatcher applies the gate BEFORE this handler runs; the handler
 * only runs when the gate allows. So when this test sees the handler
 * called, the gate allowed; when it doesn't, the gate refused.
 */
function buildProbeCommand(
  observed: { actor?: ResolvedActor; ranArgs?: unknown },
  options: { mutates: boolean; takesEnvFlag?: boolean } = { mutates: true },
): CommandDefinition {
  return {
    id: "probe.run",
    mutates: options.mutates,
    register: (parent, deps) => {
      const cmd = parent
        .command("probe")
        .description("Synthetic probe command for dispatcher tests.");
      if (options.takesEnvFlag) {
        cmd.option(
          "--env <environment>",
          "Effective environment for the run (development|staging|production).",
        );
      }
      cmd.action(
        deps.runCommand<{ env?: string }>(
          { id: "probe.run", mutates: options.mutates },
          async (args: { env?: string }, ctx: CommandContext) => {
            observed.actor = ctx.actor;
            observed.ranArgs = args;
            return undefined;
          },
        ),
      );
    },
  };
}

/**
 * In-memory operator-token repository so the resolver can run without
 * touching a real PostgreSQL.
 */
class StubRepository implements OperatorTokenRepository {
  public readonly touchCalls: Array<{ id: string; at: Date }> = [];
  private readonly rows: Map<string, OperatorTokenRow>;

  constructor(rows: readonly OperatorTokenRow[] = []) {
    this.rows = new Map();
    for (const row of rows) this.rows.set(row.operator_token_id, row);
  }

  async findById(id: string): Promise<OperatorTokenRow | null> {
    return this.rows.get(id) ?? null;
  }

  async touchLastUsedAt(id: string, at: Date): Promise<void> {
    this.touchCalls.push({ id, at });
  }
}

const activeRow: OperatorTokenRow = {
  operator_token_id: "polaris_ot_active",
  operator_label: "alice@polaris.dev",
  hash: "fake-argon2id-hash",
  hash_algorithm: POLARIS_HASH_ALGORITHM,
  status: "active",
};

const revokedRow: OperatorTokenRow = {
  operator_token_id: "polaris_ot_revoked",
  operator_label: "bob@polaris.dev",
  hash: "fake-argon2id-hash",
  hash_algorithm: POLARIS_HASH_ALGORITHM,
  status: "revoked",
};

describe("dispatcher gate: refuse production-mutating without operator token", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("refuses when --env=production and the actor is cli (no token)", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const code = await run({
      argv: ["probe", "--env", "production"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true, takesEnvFlag: true })],
    });
    expect(code).toBe(ExitCode.UsageError); // gate refusal → exit code 2
    expect(observed.actor).toBeUndefined(); // handler never ran
    const stderr = capture.stderr.join("");
    expect(stderr).toContain("production mutation refused");
    expect(stderr).toContain("POLARIS_OPERATOR_TOKEN");
    expect(stderr).toContain("production_requires_authenticated_actor");
  });

  it("refuses when POLARIS_ENV=production and no --env flag", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const code = await run({
      argv: ["probe"],
      env: { ...VALID_ENV, POLARIS_ENV: "production" },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true })],
    });
    expect(code).toBe(ExitCode.UsageError);
    expect(observed.actor).toBeUndefined();
    expect(capture.stderr.join("")).toContain("production mutation refused");
  });

  it("allows production-mutating runs when a valid operator token resolves", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const repository = new StubRepository([activeRow]);
    const code = await run({
      argv: ["probe", "--env", "production"],
      env: {
        ...VALID_ENV,
        POLARIS_OPERATOR_TOKEN: "polaris_ot_active.matching-secret",
      },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true, takesEnvFlag: true })],
      operatorTokenRepository: repository,
      // Deterministic verify stub: the suite avoids paying argon2 cost.
      operatorTokenVerify: async (plaintext, hash) =>
        plaintext === "matching-secret" && hash === activeRow.hash,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(observed.actor).toEqual({
      source: "operator_token",
      label: "alice@polaris.dev",
      tokenId: "polaris_ot_active",
    });
    // Successful resolution touched last_used_at exactly once.
    expect(repository.touchCalls).toHaveLength(1);
    expect(repository.touchCalls[0]?.id).toBe("polaris_ot_active");
  });

  it("refuses when the operator token is revoked (resolver falls back to cli)", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const repository = new StubRepository([revokedRow]);
    const code = await run({
      argv: ["probe", "--env", "production"],
      env: {
        ...VALID_ENV,
        POLARIS_OPERATOR_TOKEN: "polaris_ot_revoked.matching-secret",
      },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true, takesEnvFlag: true })],
      operatorTokenRepository: repository,
    });
    expect(code).toBe(ExitCode.UsageError);
    expect(observed.actor).toBeUndefined();
    expect(capture.stderr.join("")).toContain("production mutation refused");
    // A revoked-token run does NOT touch last_used_at.
    expect(repository.touchCalls).toHaveLength(0);
  });

  it("allows non-production mutating runs regardless of actor source", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const code = await run({
      argv: ["probe", "--env", "staging"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true, takesEnvFlag: true })],
    });
    expect(code).toBe(ExitCode.Ok);
    expect(observed.actor?.source).toBe("cli");
  });

  it("allows read-only commands in production regardless of actor source", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const code = await run({
      argv: ["probe", "--env", "production"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: false, takesEnvFlag: true })],
    });
    expect(code).toBe(ExitCode.Ok);
    expect(observed.actor?.source).toBe("cli");
  });
});

describe("dispatcher gate: actor injection via test hooks", () => {
  it("threads the supplied actor through ctx.actor", async () => {
    const observed: { actor?: ResolvedActor; ranArgs?: unknown } = {};
    const capture = captureOutput();
    const authenticated: ResolvedActor = {
      source: "operator_token",
      label: "carol@polaris.dev",
      tokenId: "polaris_ot_carol-rec",
    };
    const code = await run({
      argv: ["probe", "--env", "production"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
      commands: [buildProbeCommand(observed, { mutates: true, takesEnvFlag: true })],
      actor: authenticated,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(observed.actor).toEqual(authenticated);
  });
});

describe("dispatcher integration: destinations.disable + audit row carries the actor", () => {
  it("inserts an audit row with actor_source='operator_token' when a valid token resolves", async () => {
    // We import directly to avoid pulling commander wiring through; the
    // runner already does the audit through its store contract.
    const { buildDestinationsDisableRunner } = await import("../src/index.js");

    interface CapturedDisableAudit {
      readonly action: string;
      readonly actorSource: string;
      readonly actorLabel: string;
      readonly targetId: string;
    }
    const recorded: CapturedDisableAudit[] = [];

    const row = {
      destination_id: "polaris_dst_under-test",
      project_id: "storefront",
      environment: "production" as const,
      vendor: "meta-capi",
      instance_label: "storefront-prod",
      status: "active" as const,
      mode: "live" as const,
      max_concurrency: 4,
      max_rps: 50,
      retry_policy: "standard" as const,
      dead_letter_threshold: 5,
      disabled_reason: null,
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    };

    const runner = buildDestinationsDisableRunner({
      openStore: () => ({
        findById: async () => row,
        disableWithAudit: async (id, _reason, _now, audit) => {
          recorded.push({
            action: "destinations.disable",
            actorSource: audit.actorSource,
            actorLabel: audit.actorLabel,
            targetId: id,
          });
          return true;
        },
        close: async () => {},
      }),
      now: () => new Date("2026-05-12T15:00:00.000Z"),
      generateAuditId: () => "TEST-AUDIT-ID",
    });

    const capture = captureOutput();
    const authenticated: ResolvedActor = {
      source: "operator_token",
      label: "alice@polaris.dev",
      tokenId: "polaris_ot_alice-rec",
    };
    const ctx: CommandContext = {
      config: {
        profile: "default",
        apiUrl: "https://polaris.example.internal",
        token: "polaris_ot_test",
        tokenEnvName: "POLARIS_TOKEN",
        output: "human",
        logLevel: "warn",
        configFilePath: undefined,
      },
      logger: {
        fatal: () => {},
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        child: () =>
          ({
            fatal: () => {},
            error: () => {},
            warn: () => {},
            info: () => {},
            debug: () => {},
            trace: () => {},
          }) as unknown as CommandContext["logger"],
      } as unknown as CommandContext["logger"],
      output: capture.streams,
      meta: META,
      actor: authenticated,
    };
    await runner({ destinationId: "polaris_dst_under-test", reason: "operator decision" }, ctx);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      action: "destinations.disable",
      actorSource: "operator_token",
      actorLabel: "alice@polaris.dev",
      targetId: "polaris_dst_under-test",
    });
  });
});
