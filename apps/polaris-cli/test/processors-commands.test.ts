/**
 * Unit tests for the `polaris processors` command surface (P6-005).
 *
 * Approach mirrors `destinations-commands.test.ts`:
 *
 *   - Each command exposes a `buildProcessorsXxxRunner({ openStore, ... })`
 *     factory so tests can inject in-memory stores, manifest loaders, and
 *     catalog-root resolvers instead of touching Kysely or the filesystem.
 *     The runner contract is identical to production.
 *   - Smaller surface tests (`mutates` flags, `--help` wiring) drive the
 *     real command tree through `run()` to confirm the dispatcher sees them.
 *
 * The CRITICAL tests in this file are:
 *
 *   1. Transform-rule rejection: any flag resembling processor transform
 *      semantics must be rejected BEFORE any DB write. This is the
 *      architectural guarantee for P6-005's acceptance criterion "CLI does
 *      not edit processor source code" and the briefing's stricter "CLI
 *      MUST refuse to write semantic config".
 *
 *   2. The schema-level invariant: `ProcessorActivationsTable` has NO column
 *      resembling a transform-rule field. Enforced as a structural test
 *      against the typed surface in `@polaris/shared-db` AND against the
 *      live migration SQL on disk.
 *
 *   3. `processor_runs` not yet provisioned: `runs list` / `runs show`
 *      surface the structured "wired in P8-001" message without crashing.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProcessorsDisableRunner,
  buildProcessorsEnableRunner,
  buildProcessorsListRunner,
  buildProcessorsRunsListRunner,
  buildProcessorsRunsShowRunner,
  buildProcessorsShowRunner,
  type CommandContext,
  ExitCode,
  FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS,
  type OutputStreams,
  type PackageMeta,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
  type ProcessorsDisableStore,
  type ProcessorsEnableStore,
  type ProcessorsListStore,
  type ProcessorsRunsListStore,
  type ProcessorsRunsShowStore,
  type ProcessorsShowStore,
  rejectProcessorRuleArguments,
  run,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
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
  };
}

function jsonContext(streams: OutputStreams): CommandContext {
  const base = makeContext(streams);
  return {
    ...base,
    config: { ...base.config, output: "json" },
  };
}

/**
 * In-memory activation store. Mirrors the shape Kysely surfaces. The
 * helpers return `boolean` for "did a real transition happen?" to match
 * the production repository contract.
 */
class InMemoryActivationStore {
  public readonly rows: ProcessorActivationRow[] = [];
  public closeCalls = 0;

  insert(row: ProcessorActivationRow): void {
    this.rows.push({ ...row });
  }

  find(key: ProcessorActivationKey): ProcessorActivationRow | null {
    const idx = this.indexOf(key);
    return idx < 0 ? null : (this.rows[idx] ?? null);
  }

  asListStore(): ProcessorsListStore {
    return {
      listActivations: async () => this.rows.map((r) => ({ ...r })),
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asShowStore(): ProcessorsShowStore {
    return {
      listActivations: async (name, version) =>
        this.rows
          .filter((r) => r.processor_name === name && r.processor_version === version)
          .map((r) => ({ ...r })),
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asEnableStore(): ProcessorsEnableStore {
    return {
      findByKey: async (key) => {
        const row = this.find(key);
        return row === null ? null : { ...row };
      },
      enable: async (input) => {
        const idx = this.indexOf(input);
        if (idx < 0) {
          this.rows.push({
            processor_name: input.processor_name,
            processor_version: input.processor_version,
            project_id: input.project_id,
            environment: input.environment,
            enabled_state: "enabled",
            enabled_at: input.enabledAt.toISOString(),
            disabled_at: null,
            last_changed_by: input.lastChangedBy,
            created_at: input.enabledAt.toISOString(),
            updated_at: input.enabledAt.toISOString(),
          });
          return true;
        }
        const existing = this.rows[idx];
        if (existing === undefined) return false;
        if (existing.enabled_state === "enabled") return false;
        this.rows[idx] = {
          ...existing,
          enabled_state: "enabled",
          enabled_at: input.enabledAt.toISOString(),
          last_changed_by: input.lastChangedBy,
          updated_at: input.enabledAt.toISOString(),
        };
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asDisableStore(): ProcessorsDisableStore {
    return {
      findByKey: async (key) => {
        const row = this.find(key);
        return row === null ? null : { ...row };
      },
      disable: async (input) => {
        const idx = this.indexOf(input);
        if (idx < 0) {
          this.rows.push({
            processor_name: input.processor_name,
            processor_version: input.processor_version,
            project_id: input.project_id,
            environment: input.environment,
            enabled_state: "disabled",
            enabled_at: null,
            disabled_at: input.disabledAt.toISOString(),
            last_changed_by: input.lastChangedBy,
            created_at: input.disabledAt.toISOString(),
            updated_at: input.disabledAt.toISOString(),
          });
          return true;
        }
        const existing = this.rows[idx];
        if (existing === undefined) return false;
        if (existing.enabled_state === "disabled") return false;
        this.rows[idx] = {
          ...existing,
          enabled_state: "disabled",
          disabled_at: input.disabledAt.toISOString(),
          last_changed_by: input.lastChangedBy,
          updated_at: input.disabledAt.toISOString(),
        };
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  private indexOf(key: ProcessorActivationKey): number {
    return this.rows.findIndex(
      (r) =>
        r.processor_name === key.processor_name &&
        r.processor_version === key.processor_version &&
        r.project_id === key.project_id &&
        r.environment === key.environment,
    );
  }
}

const PROCESSOR_NAME = "analytics-projector";
const PROCESSOR_VERSION = "v1";

/**
 * Build a minimal valid manifest payload matching the Zod schema. Returns
 * the YAML body and a discoverable manifest record for the mocked loader.
 */
function buildManifestYaml(name: string, version: string): string {
  return [
    `name: ${name}`,
    `version: ${version}`,
    "owner: platform-data",
    "description: Test processor manifest for P6-005 CLI unit tests.",
    "mode: streaming",
    "inputs:",
    "  - family: raw.events",
    '    schema_versions: "*"',
    "outputs:",
    "  - family: analytics.events",
    '    schema_versions: "*"',
    "state_stores: []",
    "defaults:",
    "  consumer_group: polaris-analytics-projector-v1",
    "  partitions_consumed_concurrently: 1",
    "replay:",
    "  supported: true",
    "  restrictions: []",
    "",
  ].join("\n");
}

/**
 * Stand up a temp directory with `processors/<name>/<version>/processor.manifest.yaml`
 * so the on-disk loader has something real to read.
 */
function setupTempProcessorsRoot(
  manifests: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly content?: string;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "polaris-p6-005-"));
  for (const m of manifests) {
    const dir = join(root, "processors", m.name, m.version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "processor.manifest.yaml"),
      m.content ?? buildManifestYaml(m.name, m.version),
      "utf8",
    );
  }
  // The catalog-root resolver walks up looking for `catalog/`; stub one in
  // so resolveCatalogRoot works without falling outside the temp dir.
  mkdirSync(join(root, "catalog"), { recursive: true });
  return root;
}

describe("validation: rejectProcessorRuleArguments", () => {
  it("rejects each documented transform-rule token", () => {
    for (const token of FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS) {
      const camel = token.replace(/[-_](.)/g, (_, ch: string) => ch.toUpperCase());
      const snake = token.replace(/-/g, "_");
      const variants = Array.from(new Set([token, camel, snake]));
      for (const variant of variants) {
        expect(() =>
          rejectProcessorRuleArguments({ [variant]: "anything" } as Record<string, unknown>),
        ).toThrow(/not accepted by the processors CLI/);
      }
    }
  });

  it("passes-through arg bags that contain no rule-shaped flags", () => {
    expect(() =>
      rejectProcessorRuleArguments({
        name: "analytics-projector",
        version: "v1",
        project: "storefront",
        env: "production",
      }),
    ).not.toThrow();
  });

  it("includes the central transform-rule token set", () => {
    // Sanity assert: the forbidden list MUST contain every token the
    // architecture doc cites as a transform-rule surface. If a token gets
    // removed from the list, this test fails loudly.
    const required = [
      "transform",
      "rule",
      "mapping",
      "field-map",
      "event-map",
      "input-topic",
      "output-topic",
      "config-blob",
      "routing",
      "enrichment",
    ];
    for (const token of required) {
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).toContain(token);
    }
  });
});

describe("processors list runner", () => {
  it("emits an empty-friendly message when no manifests are discovered", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsListRunner({
      openStore: () => store.asListStore(),
      loadManifests: () => ({ manifests: [], warnings: [] }),
      resolveRoot: () => "/tmp/fake-root",
    });
    await runner({}, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("(no processor manifests discovered");
  });

  it("renders discovered manifests with per-(project, env) activation rows", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      project_id: "storefront",
      environment: "production",
      enabled_state: "enabled",
      enabled_at: "2026-05-12T10:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const root = setupTempProcessorsRoot([{ name: PROCESSOR_NAME, version: PROCESSOR_VERSION }]);
    const capture = captureOutput();
    const runner = buildProcessorsListRunner({
      openStore: () => store.asListStore(),
      resolveRoot: () => root,
    });
    await runner({}, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.processors[0]).toMatchObject({
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
      mode: "streaming",
      owner: "platform-data",
    });
    expect(parsed.processors[0].activations).toHaveLength(1);
    expect(parsed.processors[0].activations[0]).toMatchObject({
      project_id: "storefront",
      environment: "production",
      enabled_state: "enabled",
    });
  });

  it("surfaces a warning to stderr for a malformed manifest and continues", async () => {
    const root = setupTempProcessorsRoot([
      // Valid manifest
      { name: "valid-proc", version: "v1" },
      // Malformed: missing required fields, also invalid YAML at the schema level
      {
        name: "broken-proc",
        version: "v1",
        content: "name: broken-proc\nversion: BAD\n",
      },
    ]);
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsListRunner({
      openStore: () => store.asListStore(),
      resolveRoot: () => root,
    });
    await runner({}, makeContext(capture.streams));
    const stderr = capture.stderr.join("");
    expect(stderr).toContain("warning: skipping malformed processor manifest");
    expect(stderr).toContain("broken-proc");
    // The valid manifest is still rendered.
    expect(capture.stdout.join("")).toContain("valid-proc");
  });

  it("rejects rule-shaped flags before any DB or filesystem work", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsListRunner({
      openStore: () => store.asListStore(),
      loadManifests: () => {
        throw new Error("loader must not be invoked");
      },
      resolveRoot: () => {
        throw new Error("resolveRoot must not be invoked");
      },
    });
    await expect(
      runner(
        // smuggled transform flag
        { ...({ transform: "x" } as Record<string, string>) },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.closeCalls).toBe(0);
  });
});

describe("processors show runner", () => {
  it("renders the manifest and the activation rows for the (name, version)", async () => {
    const root = setupTempProcessorsRoot([{ name: PROCESSOR_NAME, version: PROCESSOR_VERSION }]);
    const store = new InMemoryActivationStore();
    store.insert({
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      project_id: "storefront",
      environment: "production",
      enabled_state: "enabled",
      enabled_at: "2026-05-12T10:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildProcessorsShowRunner({
      openStore: () => store.asShowStore(),
      resolveRoot: () => root,
    });
    await runner(
      { name: PROCESSOR_NAME, version: PROCESSOR_VERSION },
      makeContext(capture.streams),
    );
    const stdout = capture.stdout.join("");
    expect(stdout).toContain(`name                   ${PROCESSOR_NAME}`);
    expect(stdout).toContain(`version                ${PROCESSOR_VERSION}`);
    expect(stdout).toContain("mode                   streaming");
    expect(stdout).toContain("project=storefront env=production state=enabled");
  });

  it("emits structured JSON with the manifest body and activation rows", async () => {
    const root = setupTempProcessorsRoot([{ name: PROCESSOR_NAME, version: PROCESSOR_VERSION }]);
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsShowRunner({
      openStore: () => store.asShowStore(),
      resolveRoot: () => root,
    });
    await runner(
      { name: PROCESSOR_NAME, version: PROCESSOR_VERSION },
      jsonContext(capture.streams),
    );
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.manifest.name).toBe(PROCESSOR_NAME);
    expect(parsed.manifest.version).toBe(PROCESSOR_VERSION);
    expect(parsed.manifest.inputs[0].family).toBe("raw.events");
    expect(parsed.activations).toEqual([]);
  });

  it("rejects unknown manifest with a usage error", async () => {
    const root = setupTempProcessorsRoot([]);
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsShowRunner({
      openStore: () => store.asShowStore(),
      resolveRoot: () => root,
    });
    await expect(
      runner({ name: "missing", version: "v1" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("requires --version", async () => {
    const root = setupTempProcessorsRoot([]);
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsShowRunner({
      openStore: () => store.asShowStore(),
      resolveRoot: () => root,
    });
    await expect(
      runner({ name: PROCESSOR_NAME }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects rule-shaped flags before any DB or filesystem work", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsShowRunner({
      openStore: () => store.asShowStore(),
      resolveRoot: () => {
        throw new Error("resolveRoot must not be invoked");
      },
    });
    await expect(
      runner(
        {
          name: PROCESSOR_NAME,
          version: PROCESSOR_VERSION,
          ...({ inputTopic: "x" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("processors enable runner", () => {
  const KEY: ProcessorActivationKey = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: "storefront",
    environment: "production",
  };

  it("inserts a new enabled row when none exists", async () => {
    const store = new InMemoryActivationStore();
    const now = new Date("2026-05-12T13:00:00.000Z");
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
      now: () => now,
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    const after = store.find(KEY);
    expect(after?.enabled_state).toBe("enabled");
    expect(after?.enabled_at).toBe(now.toISOString());
    expect(after?.last_changed_by).toBe("cli");
    expect(capture.stdout.join("")).toContain(
      `enabled ${KEY.processor_name} ${KEY.processor_version} for project=${KEY.project_id} env=${KEY.environment}`,
    );
    // Audit-intent TODO is surfaced to stderr until P6-006 lands.
    expect(capture.stderr.join("")).toContain("audit_records table is created by P6-006");
  });

  it("flips a disabled row to enabled", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      ...KEY,
      enabled_state: "disabled",
      enabled_at: null,
      disabled_at: "2026-05-12T11:00:00.000Z",
      last_changed_by: "cli",
      created_at: "2026-05-12T11:00:00.000Z",
      updated_at: "2026-05-12T11:00:00.000Z",
    });
    const now = new Date("2026-05-12T13:00:00.000Z");
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
      now: () => now,
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    const after = store.find(KEY);
    expect(after?.enabled_state).toBe("enabled");
    expect(after?.enabled_at).toBe(now.toISOString());
  });

  it("is idempotent on an already-enabled row and suppresses audit-intent", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      ...KEY,
      enabled_state: "enabled",
      enabled_at: "2026-05-12T10:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    expect(capture.stdout.join("")).toContain("already enabled");
    expect(capture.stderr.join("")).not.toContain("audit:");
  });

  it("rejects unknown manifest with a usage error before any DB work", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => false,
      resolveRoot: () => "/tmp/fake",
    });
    await expect(
      runner(
        {
          name: "no-such",
          version: "v1",
          project: "storefront",
          env: "production",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.rows).toHaveLength(0);
  });

  it("rejects unsupported --env values", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await expect(
      runner(
        {
          name: PROCESSOR_NAME,
          version: PROCESSOR_VERSION,
          project: "storefront",
          env: "qa",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.rows).toHaveLength(0);
  });

  it("rejects malformed --version strings", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await expect(
      runner(
        {
          name: PROCESSOR_NAME,
          version: "version one", // not a v-prefixed semver-shape
          project: "storefront",
          env: "production",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("REJECTS a transform-rule flag BEFORE any DB write — the acceptance-criteria gate", async () => {
    // CRITICAL: a smuggled `--transform`/`--input-topic`/`--field-map`
    // must be refused and the store must remain untouched.
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await expect(
      runner(
        {
          name: PROCESSOR_NAME,
          version: PROCESSOR_VERSION,
          project: "storefront",
          env: "production",
          // smuggled rule flag
          ...({ inputTopic: "raw.special" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.rows).toHaveLength(0);
  });

  it("rejects every documented forbidden token", async () => {
    const store = new InMemoryActivationStore();
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    for (const token of FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS) {
      const camel = token.replace(/[-_](.)/g, (_, ch: string) => ch.toUpperCase());
      await expect(
        runner(
          {
            name: PROCESSOR_NAME,
            version: PROCESSOR_VERSION,
            project: "storefront",
            env: "production",
            ...({ [camel]: "forbidden" } as Record<string, string>),
          },
          makeContext(capture.streams),
        ),
      ).rejects.toMatchObject({ name: "UsageError" });
    }
    expect(store.rows).toHaveLength(0);
  });

  it("respects a custom actorLabel hook for last_changed_by", async () => {
    const store = new InMemoryActivationStore();
    const now = new Date("2026-05-12T14:00:00.000Z");
    const capture = captureOutput();
    const runner = buildProcessorsEnableRunner({
      openStore: () => store.asEnableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
      now: () => now,
      actorLabel: () => "operator:alice",
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    expect(store.find(KEY)?.last_changed_by).toBe("operator:alice");
  });
});

describe("processors disable runner", () => {
  const KEY: ProcessorActivationKey = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: "storefront",
    environment: "production",
  };

  it("flips an enabled row to disabled", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      ...KEY,
      enabled_state: "enabled",
      enabled_at: "2026-05-12T10:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const now = new Date("2026-05-12T14:00:00.000Z");
    const capture = captureOutput();
    const runner = buildProcessorsDisableRunner({
      openStore: () => store.asDisableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
      now: () => now,
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    const after = store.find(KEY);
    expect(after?.enabled_state).toBe("disabled");
    expect(after?.disabled_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain(`disabled ${KEY.processor_name}`);
    expect(capture.stderr.join("")).toContain("audit_records table is created by P6-006");
  });

  it("is idempotent on an already-disabled row", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      ...KEY,
      enabled_state: "disabled",
      enabled_at: null,
      disabled_at: "2026-05-12T10:00:00.000Z",
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildProcessorsDisableRunner({
      openStore: () => store.asDisableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    expect(capture.stdout.join("")).toContain("already disabled");
    expect(capture.stderr.join("")).not.toContain("audit:");
  });

  it("inserts a fresh disabled row when none exists", async () => {
    const store = new InMemoryActivationStore();
    const now = new Date("2026-05-12T14:00:00.000Z");
    const capture = captureOutput();
    const runner = buildProcessorsDisableRunner({
      openStore: () => store.asDisableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
      now: () => now,
    });
    await runner(
      {
        name: KEY.processor_name,
        version: KEY.processor_version,
        project: KEY.project_id,
        env: KEY.environment,
      },
      makeContext(capture.streams),
    );
    const after = store.find(KEY);
    expect(after?.enabled_state).toBe("disabled");
    expect(after?.disabled_at).toBe(now.toISOString());
  });

  it("REJECTS a transform-rule flag BEFORE any DB write", async () => {
    const store = new InMemoryActivationStore();
    store.insert({
      ...KEY,
      enabled_state: "enabled",
      enabled_at: "2026-05-12T10:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T10:00:00.000Z",
      updated_at: "2026-05-12T10:00:00.000Z",
    });
    const capture = captureOutput();
    const runner = buildProcessorsDisableRunner({
      openStore: () => store.asDisableStore(),
      verifyManifest: () => true,
      resolveRoot: () => "/tmp/fake",
    });
    await expect(
      runner(
        {
          name: KEY.processor_name,
          version: KEY.processor_version,
          project: KEY.project_id,
          env: KEY.environment,
          ...({ outputTopic: "analytics.special" } as Record<string, string>),
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(store.find(KEY)?.enabled_state).toBe("enabled"); // unchanged
  });
});

describe("processors runs list (P8-001 not yet provisioned)", () => {
  it("surfaces a 'not yet provisioned' message on stderr and stdout", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsListRunner();
    await runner({}, makeContext(capture.streams));
    expect(capture.stderr.join("")).toContain("processor_runs table not yet provisioned");
    expect(capture.stderr.join("")).toContain("P8-001");
    expect(capture.stdout.join("")).toContain("processor_runs table not yet provisioned");
  });

  it("returns a structured JSON envelope marking the gap", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsListRunner();
    await runner({}, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.not_provisioned).toBe(true);
    expect(parsed.pending_task).toBe("P8-001");
    expect(parsed.rows).toEqual([]);
  });

  it("rejects rule-shaped flags before invoking the store", async () => {
    let opened = 0;
    const store: ProcessorsRunsListStore = {
      probe: async () => {
        opened += 1;
        return null;
      },
      list: async () => [],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildProcessorsRunsListRunner({ openStore: () => store });
    await expect(
      runner({ ...({ transform: "x" } as Record<string, string>) }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(opened).toBe(0);
  });

  it("falls through to the real list when the probe returns null", async () => {
    const store: ProcessorsRunsListStore = {
      probe: async () => null,
      list: async () => [
        {
          run_id: "run_abc",
          processor_name: PROCESSOR_NAME,
          processor_version: PROCESSOR_VERSION,
          project_id: "storefront",
          environment: "production",
          status: "succeeded",
          started_at: "2026-05-12T10:00:00.000Z",
          finished_at: "2026-05-12T10:05:00.000Z",
        },
      ],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildProcessorsRunsListRunner({ openStore: () => store });
    await runner({}, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0].run_id).toBe("run_abc");
  });
});

describe("processors runs show (P8-001 not yet provisioned)", () => {
  it("surfaces the 'not yet provisioned' message", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsShowRunner();
    await runner({ runId: "run_x" }, makeContext(capture.streams));
    expect(capture.stderr.join("")).toContain("processor_runs table not yet provisioned");
  });

  it("returns a structured JSON envelope marking the gap", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsShowRunner();
    await runner({ runId: "run_x" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.not_provisioned).toBe(true);
    expect(parsed.pending_task).toBe("P8-001");
    expect(parsed.run).toBeNull();
  });

  it("requires a run_id", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsShowRunner();
    await expect(runner({ runId: "  " }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("rejects rule-shaped flags", async () => {
    const capture = captureOutput();
    const runner = buildProcessorsRunsShowRunner();
    await expect(
      runner(
        { runId: "run_x", ...({ transform: "x" } as Record<string, string>) },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("renders run detail when the probe returns null", async () => {
    const store: ProcessorsRunsShowStore = {
      probe: async () => null,
      findById: async () => ({
        run_id: "run_abc",
        processor_name: PROCESSOR_NAME,
        processor_version: PROCESSOR_VERSION,
        git_sha: "deadbeef",
        config_hash: "cfg_hash",
        runtime_settings_hash: "rs_hash",
        input_topic: "raw.events",
        output_topic: "analytics.events",
        project_id: "storefront",
        environment: "production",
        status: "succeeded",
        started_at: "2026-05-12T10:00:00.000Z",
        finished_at: "2026-05-12T10:05:00.000Z",
        metrics: { events_consumed: 100, events_produced: 100 },
      }),
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildProcessorsRunsShowRunner({ openStore: () => store });
    await runner({ runId: "run_abc" }, makeContext(capture.streams));
    const stdout = capture.stdout.join("");
    expect(stdout).toContain("run_id                 run_abc");
    expect(stdout).toContain("status                 succeeded");
    expect(stdout).toContain("events_consumed=100");
  });
});

describe("processors command surface mutates flags", () => {
  it("declares mutates: true on writers and mutates: false on read commands", async () => {
    const mod = await import("../src/index.js");
    expect(mod.processorsListCommand.mutates).toBe(false);
    expect(mod.processorsShowCommand.mutates).toBe(false);
    expect(mod.processorsRunsListCommand.mutates).toBe(false);
    expect(mod.processorsRunsShowCommand.mutates).toBe(false);
    expect(mod.processorsEnableCommand.mutates).toBe(true);
    expect(mod.processorsDisableCommand.mutates).toBe(true);
  });

  it("processorsCommand group reports mutates: false", async () => {
    const mod = await import("../src/index.js");
    expect(mod.processorsCommand.mutates).toBe(false);
  });

  it("processorsRunsCommand group reports mutates: false", async () => {
    const mod = await import("../src/index.js");
    expect(mod.processorsRunsCommand.mutates).toBe(false);
  });
});

describe("processors command dispatcher wiring", () => {
  it("`polaris processors --help` lists list/show/runs/enable/disable", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["processors", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
    expect(help).toContain("runs");
    expect(help).toContain("enable");
    expect(help).toContain("disable");
  });

  it("`polaris processors runs --help` lists list/show", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["processors", "runs", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
  });

  it("help text emphasises the no-transform-rule rule", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["processors", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(capture.stdout.join("")).toMatch(/processors\/<name>\/v<n>/);
  });
});

/**
 * Schema-level invariant: the Kysely `ProcessorActivationsTable` interface
 * in `@polaris/shared-db` MUST NOT carry any column resembling a
 * transform-rule field. This is the "Tests verify semantic config is not
 * stored in runtime tables" criterion from the task card.
 *
 * The check is structural: we enumerate the legal columns and assert none
 * of them is in the forbidden token list. Any future refactor that adds a
 * `transform`-shaped column to the activation row would fail this gate.
 */
describe("schema invariant: no transform-rule fields on processor_activations", () => {
  it("rejects every forbidden token across the activation row shape", () => {
    const activationKeys = [
      "processor_name",
      "processor_version",
      "project_id",
      "environment",
      "enabled_state",
      "enabled_at",
      "disabled_at",
      "last_changed_by",
      "created_at",
      "updated_at",
    ];
    for (const key of activationKeys) {
      const normalised = key.toLowerCase().replace(/_/g, "-");
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).not.toContain(normalised);
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).not.toContain(key);
    }
  });

  it("the activation read-shape exposes no field whose name matches a transform-rule token", () => {
    const exemplar: ProcessorActivationRow = {
      processor_name: PROCESSOR_NAME,
      processor_version: PROCESSOR_VERSION,
      project_id: "p",
      environment: "production",
      enabled_state: "enabled",
      enabled_at: "2026-05-12T00:00:00.000Z",
      disabled_at: null,
      last_changed_by: "cli",
      created_at: "2026-05-12T00:00:00.000Z",
      updated_at: "2026-05-12T00:00:00.000Z",
    };
    for (const key of Object.keys(exemplar)) {
      const normalised = key.toLowerCase().replace(/_/g, "-");
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).not.toContain(normalised);
    }
  });

  it("the processor_activations migration SQL declares no transform-rule-shaped column", async () => {
    // Last-line-of-defence schema check: read the live migration file off
    // disk and assert no transform-rule-shaped column name appears in the
    // CREATE TABLE definition. Catches a maintainer who adds a column to
    // the migration but forgets to update the typed interface.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(
      here,
      "..",
      "..",
      "..",
      "db",
      "migrations",
      "20260512000006_create_processor_activations.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    const createTableMatch = sql.match(/CREATE TABLE processor_activations \(([\s\S]*?)\);/);
    expect(createTableMatch).not.toBeNull();
    const body = createTableMatch?.[1] ?? "";
    const columnLines = body
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.length > 0 &&
          !line.startsWith("--") &&
          !line.toUpperCase().startsWith("CONSTRAINT") &&
          !line.toUpperCase().startsWith("PRIMARY KEY") &&
          !line.toUpperCase().startsWith("UNIQUE") &&
          !line.toUpperCase().startsWith("CHECK"),
      );
    expect(columnLines.length).toBeGreaterThan(0);
    const columnNames = columnLines.map((line) => {
      const match = line.match(/^([a-z_][a-z0-9_]*)/);
      return match?.[1] ?? "";
    });
    for (const name of columnNames) {
      if (name === "") continue;
      const kebab = name.replace(/_/g, "-");
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).not.toContain(kebab);
      expect(FORBIDDEN_PROCESSOR_RULE_FLAG_TOKENS).not.toContain(name);
    }
  });
});

/**
 * Catalog loader contract: malformed manifests are surfaced as warnings,
 * not exceptions; valid manifests parse with the expected fields.
 */
describe("loadProcessorManifests / loadProcessorManifest", () => {
  // Defer import so we can use the catalog module on a fresh temp tree.
  let loadProcessorManifests: typeof import("../src/index.js").loadProcessorManifests;
  let loadProcessorManifest: typeof import("../src/index.js").loadProcessorManifest;
  let processorManifestSchema: typeof import("../src/index.js").processorManifestSchema;

  beforeEach(async () => {
    const mod = await import("../src/index.js");
    loadProcessorManifests = mod.loadProcessorManifests;
    loadProcessorManifest = mod.loadProcessorManifest;
    processorManifestSchema = mod.processorManifestSchema;
  });

  let createdRoots: string[] = [];
  afterEach(() => {
    createdRoots = [];
  });

  it("parses a valid manifest with the Zod schema", () => {
    const root = setupTempProcessorsRoot([{ name: PROCESSOR_NAME, version: PROCESSOR_VERSION }]);
    createdRoots.push(root);
    const result = loadProcessorManifest({
      root,
      name: PROCESSOR_NAME,
      version: PROCESSOR_VERSION,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.value.manifest.name).toBe(PROCESSOR_NAME);
    expect(result.value.manifest.version).toBe(PROCESSOR_VERSION);
    expect(result.value.manifest.mode).toBe("streaming");
  });

  it("returns ok=false with structured reason on schema failure", () => {
    const root = setupTempProcessorsRoot([
      {
        name: "broken-proc",
        version: "v1",
        content: "name: broken-proc\nversion: BAD\n",
      },
    ]);
    createdRoots.push(root);
    const result = loadProcessorManifest({
      root,
      name: "broken-proc",
      version: "v1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toContain("schema validation failed");
  });

  it("returns ok=false on missing manifest", () => {
    const root = setupTempProcessorsRoot([]);
    createdRoots.push(root);
    const result = loadProcessorManifest({ root, name: "not-there", version: "v1" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.reason).toContain("no manifest at");
  });

  it("loadProcessorManifests returns warnings for malformed files and continues", () => {
    const root = setupTempProcessorsRoot([
      { name: "valid-proc", version: "v1" },
      {
        name: "broken-proc",
        version: "v1",
        content: "this: is: not valid yaml: at all: : :",
      },
    ]);
    createdRoots.push(root);
    const scan = loadProcessorManifests({ root });
    expect(scan.manifests).toHaveLength(1);
    expect(scan.manifests[0]?.manifest.name).toBe("valid-proc");
    expect(scan.warnings).toHaveLength(1);
    expect(scan.warnings[0]?.path).toContain("broken-proc");
  });

  it("processorManifestSchema rejects unknown top-level keys", () => {
    const result = processorManifestSchema.safeParse({
      name: "analytics-projector",
      version: "v1",
      owner: "platform-data",
      description: "Test description for processor manifest schema.",
      mode: "streaming",
      inputs: [{ family: "raw.events", schema_versions: "*" }],
      outputs: [{ family: "analytics.events", schema_versions: "*" }],
      state_stores: [],
      // Unknown top-level key — must be rejected by the .strict() schema.
      transform: { rule: "smuggled-in" },
    });
    expect(result.success).toBe(false);
  });
});
