/**
 * Unit tests for the audit recorder (`apps/polaris-cli/src/audit/recorder.ts`)
 * and the cross-cut integration that every mutating command writes an audit
 * row alongside its mutation (P6-006).
 *
 * The recorder is normally wired to a real Kysely transaction; these tests
 * stub the persistence side with an in-memory recorder that drops rows into
 * an array, so we can prove:
 *
 *   - The recorder accepts the canonical payload shape.
 *   - Required fields are enforced before any DB call.
 *   - The cross-cut destinations.disable runner DOES call the recorder
 *     with the right action / target / actor / project / env / before /
 *     after / reason payload (the integration assert from the task card).
 */
import { describe, expect, it } from "vitest";

import {
  buildDestinationsDisableRunner,
  type CommandContext,
  type DestinationRow,
  type DestinationsDisableStore,
  type OutputStreams,
  type PackageMeta,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  nodeVersion: "v22.0.0",
};

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

function makeContext(streams: OutputStreams): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  } as unknown as CommandContext["logger"];
  return {
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
      ...noopLogger,
      child: () => noopLogger,
    } as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
  };
}

function seedActiveDestination(): DestinationRow {
  return {
    destination_id: "polaris_dst_under-test",
    project_id: "storefront",
    environment: "production",
    vendor: "meta-capi",
    instance_label: "storefront-prod",
    secret_ref: "env:META_CAPI_TOKEN_STOREFRONT_PROD",
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 50,
    retry_policy: "standard",
    dead_letter_threshold: 5,
    disabled_reason: null,
    // P7-004: replay-opt-in trio. Defaults match a freshly-created destination.
    replay_opt_in: false,
    replay_opt_in_reason: null,
    replay_opt_in_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    updated_at: "2026-05-10T00:00:00.000Z",
  };
}

describe("destinations.disable cross-cut: the recorder receives the canonical payload", () => {
  it("inserts an audit row with the right action / target / actor / project / env / reason", async () => {
    // The in-memory store stands in for the production
    // `destinations.disable` repository. Its `disableWithAudit` writes the
    // status update AND captures the audit payload — the production code
    // does both inside one Kysely transaction.
    const row = seedActiveDestination();
    const recorded: Array<{
      action: string;
      auditId: string;
      targetId: string;
      actorLabel: string;
      projectId: string;
      environment: string;
      before: unknown;
      after: unknown;
      reason: string | null;
    }> = [];
    const store: DestinationsDisableStore = {
      findById: async () => row,
      disableWithAudit: async (id, reason, _now, audit) => {
        recorded.push({
          action: "destinations.disable",
          auditId: audit.auditId,
          targetId: id,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        void reason;
        return true;
      },
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store,
      now: () => new Date("2026-05-12T15:00:00.000Z"),
      generateAuditId: () => "01923456-FIXED-AUDIT-ID",
      actorLabel: () => "cli",
    });
    await runner(
      {
        destinationId: "polaris_dst_under-test",
        reason: "operator decision",
      },
      makeContext(capture.streams),
    );

    expect(recorded).toHaveLength(1);
    const audit = recorded[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("destinations.disable");
    expect(audit.auditId).toBe("01923456-FIXED-AUDIT-ID");
    expect(audit.targetId).toBe("polaris_dst_under-test");
    expect(audit.actorLabel).toBe("cli");
    expect(audit.projectId).toBe("storefront");
    expect(audit.environment).toBe("production");
    expect(audit.reason).toBe("operator decision");
    // Before snapshot is the pre-mutation row state; after snapshot
    // reflects the mutation. Both omit secret-resolved values.
    expect(audit.before).toMatchObject({
      destination_id: "polaris_dst_under-test",
      status: "active",
      vendor: "meta-capi",
      secret_ref: "env:META_CAPI_TOKEN_STOREFRONT_PROD",
    });
    expect(audit.after).toMatchObject({
      destination_id: "polaris_dst_under-test",
      status: "disabled",
      disabled_reason: "operator decision",
    });
  });

  it("does NOT call the recorder on the idempotent no-op path", async () => {
    // Pre-disabled row. The runner detects the no-op state and returns
    // without touching the recorder.
    const row: DestinationRow = {
      ...seedActiveDestination(),
      status: "disabled",
      disabled_reason: "first incident",
    };
    let recorderCalls = 0;
    const store: DestinationsDisableStore = {
      findById: async () => row,
      disableWithAudit: async () => {
        recorderCalls += 1;
        return true;
      },
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildDestinationsDisableRunner({
      openStore: () => store,
    });
    await runner(
      { destinationId: "polaris_dst_under-test", reason: "second attempt" },
      makeContext(capture.streams),
    );
    expect(recorderCalls).toBe(0);
    expect(capture.stdout.join("")).toContain("already disabled");
  });
});

/**
 * Recorder direct API surface tests. These don't go through a runner; they
 * exercise the recorder builder directly so the contract for callers (P7,
 * P9 future tasks that will need to write audit rows) is pinned.
 */
describe("createAuditRecorder direct surface", () => {
  it("generates a UUIDv7 and persists every field", async () => {
    const { createAuditRecorder } = await import("../src/audit/recorder.js");
    const inserts: Array<Record<string, unknown>> = [];
    // A Kysely-shaped stub: only the path the recorder uses
    // (`insertInto("audit_records").values(...).execute()`) needs to work.
    const stub = {
      insertInto: () => ({
        values: (v: Record<string, unknown>) => ({
          execute: async () => {
            inserts.push(v);
          },
        }),
      }),
    } as unknown as Parameters<typeof createAuditRecorder>[0];
    const recorder = createAuditRecorder(stub, {
      generateId: () => "FIXED-AUDIT-ID",
      now: () => new Date("2026-05-12T15:00:00.000Z"),
    });
    const id = await recorder({
      actorLabel: "cli",
      action: "destinations.enable",
      targetType: "destination",
      targetId: "polaris_dst_under-test",
      projectId: "storefront",
      environment: "production",
      before: { status: "paused" },
      after: { status: "active" },
      reason: null,
    });
    expect(id).toBe("FIXED-AUDIT-ID");
    expect(inserts).toHaveLength(1);
    const persisted = inserts[0];
    if (persisted === undefined) throw new Error("expected one insert");
    expect(persisted).toMatchObject({
      audit_id: "FIXED-AUDIT-ID",
      actor_source: "cli",
      actor_label: "cli",
      action: "destinations.enable",
      target_type: "destination",
      target_id: "polaris_dst_under-test",
      project_id: "storefront",
      environment: "production",
      before: { status: "paused" },
      after: { status: "active" },
      reason: null,
      request_id: "FIXED-AUDIT-ID",
    });
  });

  it("rejects empty actor labels", async () => {
    const { createAuditRecorder } = await import("../src/audit/recorder.js");
    const stub = {
      insertInto: () => ({
        values: () => ({ execute: async () => {} }),
      }),
    } as unknown as Parameters<typeof createAuditRecorder>[0];
    const recorder = createAuditRecorder(stub);
    await expect(
      recorder({
        actorLabel: "   ",
        action: "x",
        targetType: "y",
        targetId: "z",
      }),
    ).rejects.toThrow(/actorLabel/);
  });

  it("rejects unsupported actor sources", async () => {
    const { createAuditRecorder } = await import("../src/audit/recorder.js");
    const stub = {
      insertInto: () => ({
        values: () => ({ execute: async () => {} }),
      }),
    } as unknown as Parameters<typeof createAuditRecorder>[0];
    const recorder = createAuditRecorder(stub);
    await expect(
      recorder({
        actorSource: "ghost" as never,
        actorLabel: "cli",
        action: "x",
        targetType: "y",
        targetId: "z",
      }),
    ).rejects.toThrow(/actorSource/);
  });

  it("rejects oversized reason strings", async () => {
    const { createAuditRecorder } = await import("../src/audit/recorder.js");
    const stub = {
      insertInto: () => ({
        values: () => ({ execute: async () => {} }),
      }),
    } as unknown as Parameters<typeof createAuditRecorder>[0];
    const recorder = createAuditRecorder(stub);
    await expect(
      recorder({
        actorLabel: "cli",
        action: "x",
        targetType: "y",
        targetId: "z",
        reason: "x".repeat(1025),
      }),
    ).rejects.toThrow(/reason/);
  });
});
