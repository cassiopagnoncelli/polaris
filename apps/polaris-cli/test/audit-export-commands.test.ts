/**
 * Unit tests for the `polaris audit` + `polaris export` command surface
 * (P6-006) and the audit recorder.
 *
 * Approach mirrors the keys/destinations/processors tests:
 *
 *   - Each command exposes a `buildXxxRunner({ openStore, ... })` factory so
 *     tests can inject an in-memory `XxxStore` instead of a Kysely client.
 *   - Surface-level tests drive `run()` through the dispatcher to confirm the
 *     command tree is wired into the BUILTIN list.
 *
 * The CRITICAL acceptance-criterion tests in this file are the
 * secret-redaction asserts: every export command MUST omit plaintext secrets
 * and (for api-keys) the argon2id hash.
 */
import { describe, expect, it } from "vitest";
import type { SourceRow } from "../src/catalog/sync.js";
import {
  type ApiKeyRow,
  type AuditListStore,
  type AuditRecordRow,
  type AuditShowStore,
  buildAuditListRunner,
  buildAuditShowRunner,
  buildExportApiKeysRunner,
  buildExportAuditRunner,
  buildExportDestinationsRunner,
  buildExportSourcesRunner,
  type CommandContext,
  type DestinationRow,
  ExitCode,
  type ExportApiKeysStore,
  type ExportAuditStore,
  type ExportDestinationsStore,
  type ExportSourcesStore,
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

function makeContext(streams: OutputStreams, output: "human" | "json" = "human"): CommandContext {
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
      output,
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

function fakeAuditRow(overrides: Partial<AuditRecordRow> = {}): AuditRecordRow {
  return {
    audit_id: "01923456-7890-7000-8000-000000000001",
    created_at: "2026-05-12T12:00:00.000Z",
    actor_source: "cli",
    actor_label: "cli",
    action: "destinations.enable",
    target_type: "destination",
    target_id: "polaris_dst_x",
    project_id: "storefront",
    environment: "production",
    before: { status: "paused" },
    after: { status: "active" },
    reason: null,
    request_id: "01923456-7890-7000-8000-000000000001",
    ...overrides,
  };
}

describe("audit list runner", () => {
  function makeStore(rows: readonly AuditRecordRow[]): AuditListStore {
    let lastFilter: unknown;
    const store: AuditListStore & { lastFilter: () => unknown } = {
      list: async (filter) => {
        lastFilter = filter;
        return rows;
      },
      close: async () => {},
      lastFilter: () => lastFilter,
    };
    return store;
  }

  it("returns an empty-friendly message when no rows match", async () => {
    const store = makeStore([]);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await runner({}, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("(no audit records");
  });

  it("renders one row per audit record in human mode", async () => {
    const rows: AuditRecordRow[] = [
      fakeAuditRow({ audit_id: "AUDIT-1", action: "destinations.enable" }),
      fakeAuditRow({ audit_id: "AUDIT-2", action: "destinations.disable", reason: "incident" }),
    ];
    const store = makeStore(rows);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await runner({}, makeContext(capture.streams));
    const joined = capture.stdout.join("");
    expect(joined).toContain("AUDIT-1");
    expect(joined).toContain("AUDIT-2");
    expect(joined).toContain("destinations.enable");
    expect(joined).toContain("destinations.disable");
    expect(joined).toContain('reason="incident"');
  });

  it("emits JSON with rows and filter under --output json", async () => {
    const rows: AuditRecordRow[] = [fakeAuditRow()];
    const store = makeStore(rows);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await runner(
      { actor: "cli", env: "production", project: "storefront", limit: "10" },
      makeContext(capture.streams, "json"),
    );
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(1);
    expect(parsed.filter).toMatchObject({
      actor_label: "cli",
      environment: "production",
      project_id: "storefront",
      limit: 10,
    });
    expect(parsed.rows).toHaveLength(1);
  });

  it("rejects unsupported --env values", async () => {
    const store = makeStore([]);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await expect(runner({ env: "qa" }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("rejects malformed --since values", async () => {
    const store = makeStore([]);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await expect(
      runner({ since: "not-an-iso" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects --since after --until", async () => {
    const store = makeStore([]);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await expect(
      runner(
        { since: "2026-05-13T00:00:00Z", until: "2026-05-12T00:00:00Z" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects --limit above MAX_LIMIT", async () => {
    const store = makeStore([]);
    const capture = captureOutput();
    const runner = buildAuditListRunner({ openStore: () => store });
    await expect(runner({ limit: "2000" }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });
});

describe("audit show runner", () => {
  it("returns the full row with before/after JSON in human mode", async () => {
    const row = fakeAuditRow({
      audit_id: "AUDIT-SHOW",
      reason: "operator decision",
      before: { status: "active", instance_label: "storefront-prod" },
      after: { status: "disabled", instance_label: "storefront-prod" },
    });
    const store: AuditShowStore = {
      findById: async (id) => (id === "AUDIT-SHOW" ? row : null),
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildAuditShowRunner({ openStore: () => store });
    await runner({ auditId: "AUDIT-SHOW" }, makeContext(capture.streams));
    const out = capture.stdout.join("");
    expect(out).toContain("AUDIT-SHOW");
    expect(out).toContain("destinations.enable");
    expect(out).toContain("operator decision");
    expect(out).toContain("before:");
    expect(out).toContain("after:");
    expect(out).toContain("storefront-prod");
  });

  it("raises a usage error when the id is unknown", async () => {
    const store: AuditShowStore = {
      findById: async () => null,
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildAuditShowRunner({ openStore: () => store });
    await expect(
      runner({ auditId: "MISSING" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("export sources runner", () => {
  function fakeSourceRow(): SourceRow {
    return {
      project_id: "storefront",
      source_id: "storefront-web",
      source_type: "web",
      owner: "platform-data",
      description: "Web frontend source",
      runtime: "active",
      allowed_environments: ["development", "staging", "production"],
      status: "active",
    };
  }

  it("emits a JSON document scoped to one (project, env)", async () => {
    const store: ExportSourcesStore = {
      list: async (projectId) => (projectId === "storefront" ? [fakeSourceRow()] : []),
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportSourcesRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed).toMatchObject({
      project_id: "storefront",
      environment: "production",
      count: 1,
    });
    expect(parsed.sources[0]).toMatchObject({
      project_id: "storefront",
      source_id: "storefront-web",
      source_type: "web",
      owner: "platform-data",
      runtime: "active",
      status: "active",
    });
  });

  it("filters out sources whose allowed_environments excludes the target env", async () => {
    const dev: SourceRow = { ...fakeSourceRow(), allowed_environments: ["development"] };
    const store: ExportSourcesStore = {
      list: async () => [fakeSourceRow(), dev],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportSourcesRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(1);
  });
});

describe("export api-keys runner (CRITICAL: hash/plaintext redaction)", () => {
  function fakeKeyRow(): ApiKeyRow {
    return {
      api_key_id: "polaris_ak_listed",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    };
  }

  it("never emits a `hash` field in the JSON document", async () => {
    const store: ExportApiKeysStore = {
      list: async () => [fakeKeyRow()],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportApiKeysRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const json = capture.stdout.join("");
    // No `hash` substring whatsoever — the field is omitted from the emit
    // shape AND the upstream SELECT doesn't carry the column.
    expect(json).not.toMatch(/"hash"\s*:/);
    // Likewise no PHC-string fragments.
    expect(json).not.toMatch(/\$argon2id\$/);
    // Metadata is present.
    const parsed = JSON.parse(json);
    expect(parsed.count).toBe(1);
    expect(parsed.api_keys[0]).toMatchObject({
      api_key_id: "polaris_ak_listed",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
    });
    expect(Object.hasOwn(parsed.api_keys[0], "hash")).toBe(false);
  });

  it("never emits the on-wire token shape (`.<secret>`)", async () => {
    const store: ExportApiKeysStore = {
      list: async () => [fakeKeyRow()],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportApiKeysRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const out = capture.stdout.join("");
    // The api_key_id appears, but never followed by `.<secret-shape>`.
    expect(out).toMatch(/polaris_ak_listed/);
    expect(out).not.toMatch(/polaris_ak_listed\.[A-Za-z0-9_-]+/);
  });
});

describe("export destinations runner (CRITICAL: emits secret_ref literal, never resolved value)", () => {
  function fakeDestinationRow(overrides: Partial<DestinationRow> = {}): DestinationRow {
    return {
      destination_id: "polaris_dst_listed",
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
      // P7-004: per-instance replay opt-in. Defaults match a freshly-created destination.
      replay_opt_in: false,
      replay_opt_in_reason: null,
      replay_opt_in_at: null,
      created_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
      ...overrides,
    };
  }

  it("emits the `secret_ref` literal (provider:ref) on every row", async () => {
    const store: ExportDestinationsStore = {
      list: async () => [fakeDestinationRow()],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportDestinationsRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.destinations[0].secret_ref).toBe("env:META_CAPI_TOKEN_STOREFRONT_PROD");
  });

  it("never emits anything that looks like a resolved secret value", async () => {
    // The repository surface only carries `secret_ref`. This test pins the
    // observable contract — no field on the emit shape resembles a
    // resolved-value name.
    const store: ExportDestinationsStore = {
      list: async () => [fakeDestinationRow()],
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportDestinationsRunner({ openStore: () => store });
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const out = capture.stdout.join("");
    // No resolved-value-shaped fields.
    expect(out).not.toMatch(/"secret_value"\s*:/);
    expect(out).not.toMatch(/"plaintext"\s*:/);
    expect(out).not.toMatch(/"password"\s*:/);
    expect(out).not.toMatch(/"token"\s*:/);
  });
});

describe("export audit runner (json + ndjson)", () => {
  function fakeRows(count: number): AuditRecordRow[] {
    const rows: AuditRecordRow[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(fakeAuditRow({ audit_id: `AUDIT-${i}` }));
    }
    return rows;
  }

  it("emits a JSON envelope by default", async () => {
    const store: ExportAuditStore = {
      list: async () => fakeRows(2),
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportAuditRunner({ openStore: () => store });
    await runner(
      { since: "2026-05-10T00:00:00Z", until: "2026-05-13T00:00:00Z" },
      makeContext(capture.streams),
    );
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.count).toBe(2);
    expect(parsed.audit_records).toHaveLength(2);
    expect(parsed.filter).toMatchObject({
      since: "2026-05-10T00:00:00.000Z",
      until: "2026-05-13T00:00:00.000Z",
    });
  });

  it("emits one line per row in NDJSON format with no envelope", async () => {
    const store: ExportAuditStore = {
      list: async () => fakeRows(3),
      close: async () => {},
    };
    const capture = captureOutput();
    const runner = buildExportAuditRunner({ openStore: () => store });
    await runner(
      {
        since: "2026-05-10T00:00:00Z",
        until: "2026-05-13T00:00:00Z",
        format: "ndjson",
      },
      makeContext(capture.streams),
    );
    const joined = capture.stdout.join("");
    // Each writeOut adds one line, vitest captures append trailing newline.
    const lines = joined.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.audit_id).toMatch(/^AUDIT-/);
    }
  });

  it("requires --since and --until", async () => {
    const store: ExportAuditStore = { list: async () => [], close: async () => {} };
    const capture = captureOutput();
    const runner = buildExportAuditRunner({ openStore: () => store });
    await expect(runner({}, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("rejects --format values outside the supported set", async () => {
    const store: ExportAuditStore = { list: async () => [], close: async () => {} };
    const capture = captureOutput();
    const runner = buildExportAuditRunner({ openStore: () => store });
    await expect(
      runner(
        {
          since: "2026-05-10T00:00:00Z",
          until: "2026-05-13T00:00:00Z",
          format: "yaml",
        },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("audit + export command surface mutates flags", () => {
  it("declares mutates: false on every audit/export command", async () => {
    const mod = await import("../src/index.js");
    expect(mod.auditCommand.mutates).toBe(false);
    expect(mod.exportCommand.mutates).toBe(false);
    expect(mod.auditListCommand.mutates).toBe(false);
    expect(mod.auditShowCommand.mutates).toBe(false);
    expect(mod.exportSourcesCommand.mutates).toBe(false);
    expect(mod.exportApiKeysCommand.mutates).toBe(false);
    expect(mod.exportDestinationsCommand.mutates).toBe(false);
    expect(mod.exportAuditCommand.mutates).toBe(false);
  });
});

describe("audit + export command dispatcher wiring", () => {
  it("`polaris audit --help` lists list + show", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["audit", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("list");
    expect(help).toContain("show");
  });

  it("`polaris export --help` lists sources + api-keys + destinations + audit", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["export", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("sources");
    expect(help).toContain("api-keys");
    expect(help).toContain("destinations");
    expect(help).toContain("audit");
  });
});

/**
 * Migration shape inspection. The migration file is the schema source of
 * truth; this test confirms the `audit_records` table has the expected
 * columns and indexes.
 */
describe("audit_records migration shape", () => {
  it("declares the canonical column set", async () => {
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
      "20260512000007_create_audit_records.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    const createTableMatch = sql.match(/CREATE TABLE audit_records \(([\s\S]*?)\);/);
    expect(createTableMatch).not.toBeNull();
    const body = createTableMatch?.[1] ?? "";
    const lines = body
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
    const columnNames = lines
      .map((line) => line.match(/^([a-z_][a-z0-9_]*)/)?.[1] ?? "")
      .filter((n) => n.length > 0);
    const expected = [
      "audit_id",
      "created_at",
      "actor_source",
      "actor_label",
      "action",
      "target_type",
      "target_id",
      "project_id",
      "environment",
      "before",
      "after",
      "reason",
      "request_id",
    ];
    for (const name of expected) {
      expect(columnNames).toContain(name);
    }
  });

  it("never declares a secret/token/plaintext-shaped column", async () => {
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
      "20260512000007_create_audit_records.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    // No secret-shaped column declarations. Reason and request_id are
    // safe; the check is on column NAMES the migration creates, not
    // arbitrary substrings in comments.
    const createTableMatch = sql.match(/CREATE TABLE audit_records \(([\s\S]*?)\);/);
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
    const columnNames = columnLines
      .map((line) => line.match(/^([a-z_][a-z0-9_]*)/)?.[1] ?? "")
      .filter((n) => n.length > 0);
    const FORBIDDEN = ["secret", "token", "plaintext", "password", "secret_value", "hash"];
    for (const name of columnNames) {
      expect(FORBIDDEN).not.toContain(name);
    }
  });

  it("declares the three documented indexes", async () => {
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
      "20260512000007_create_audit_records.sql",
    );
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE INDEX audit_records_target_idx/);
    expect(sql).toMatch(/CREATE INDEX audit_records_project_env_idx/);
    expect(sql).toMatch(/CREATE INDEX audit_records_actor_idx/);
  });
});
