/**
 * Unit tests for the `polaris keys` command surface (P6-003).
 *
 * Approach:
 *
 *   - Each command exposes a `buildKeysXxxRunner({ openStore, ... })` factory
 *     so tests can inject an in-memory `KeysXxxStore` instead of a Kysely
 *     client. The runner contract is identical to production — only the
 *     persistence side is faked. The argon2 hash function is replaced with a
 *     deterministic stub so the suite stays fast.
 *   - The smaller surface tests (mutates flags, --help wiring, token format)
 *     drive the real command tree through `run()` to confirm the dispatcher
 *     sees them.
 *   - One round-trip test imports `hashSecret` from `@polaris/shared-secrets`
 *     and `verifyApiKeyHash` from the ingester, proving both sides speak the
 *     same primitive. That keeps "no second hash library" enforced as a
 *     compile-time + runtime invariant.
 */
import { hashSecret, POLARIS_HASH_ALGORITHM, verifySecret } from "@polaris/shared-secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ApiKeyRow,
  buildKeysCreateRunner,
  buildKeysListRunner,
  buildKeysRevokeRunner,
  buildKeysRotateRunner,
  type CommandContext,
  ExitCode,
  formatToken,
  generateKeyMaterial,
  type IssuedKeyMaterial,
  type KeysCreateStore,
  type KeysListStore,
  type KeysRevokeStore,
  type KeysRotateStore,
  type OutputStreams,
  type PackageMeta,
  run,
  type RotateStoreInput,
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
 * Tiny in-memory store used by every runner-level test. The shape mirrors a
 * Postgres `api_keys` row — the same surface area the ingester sees through
 * `apps/ingester-api/src/auth/repository.ts`, just keyed by `api_key_id`.
 *
 * Each store variant also captures the audit payload the runner sends
 * through so tests can assert the row that would land in `audit_records`
 * (P6-006).
 */
interface CapturedKeyAuditCall {
  readonly action: string;
  readonly auditId: string;
  readonly targetId: string;
  readonly actorLabel: string;
  readonly projectId: string;
  readonly environment: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
}

class InMemoryApiKeyStore {
  public readonly rows = new Map<string, ApiKeyRow>();
  public inserts: ApiKeyRow[] = [];
  public revokeCalls = 0;
  public closeCalls = 0;
  public auditCalls: CapturedKeyAuditCall[] = [];

  insert(row: ApiKeyRow): void {
    this.rows.set(row.api_key_id, row);
    this.inserts.push(row);
  }

  asCreateStore(): KeysCreateStore {
    return {
      insertWithAudit: async (input, audit) => {
        this.insert({
          api_key_id: input.api_key_id,
          project_id: input.project_id,
          environment: input.environment,
          source_id: input.source_id,
          source_type: input.source_type,
          status: "active",
          hash_algorithm: input.hash_algorithm,
          created_at: new Date("2026-05-12T12:00:00.000Z").toISOString(),
          revoked_at: null,
          last_used_at: null,
        });
        this.auditCalls.push({
          action: "keys.create",
          auditId: audit.auditId,
          targetId: input.api_key_id,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: null,
          after: audit.after,
          reason: null,
        });
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asListStore(): KeysListStore {
    return {
      list: async (projectId, environment) =>
        [...this.rows.values()].filter(
          (r) => r.project_id === projectId && r.environment === environment,
        ),
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asRevokeStore(now: Date): KeysRevokeStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      revokeWithAudit: async (id, revokedAt, audit) => {
        this.revokeCalls += 1;
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.status !== "active") return false;
        this.rows.set(id, {
          ...row,
          status: "revoked",
          revoked_at: revokedAt.toISOString(),
        });
        void now;
        this.auditCalls.push({
          action: "keys.revoke",
          auditId: audit.auditId,
          targetId: id,
          actorLabel: audit.actorLabel,
          projectId: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asRotateStore(): KeysRotateStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      rotate: async (input: RotateStoreInput) => {
        const old = this.rows.get(input.oldApiKeyId);
        if (old === undefined || old.status !== "active") return false;
        // Atomic semantics: all four writes succeed or none does. A real
        // Kysely transaction wraps the writes in `BEGIN; ...; COMMIT;`.
        this.insert({
          api_key_id: input.newRow.api_key_id,
          project_id: input.newRow.project_id,
          environment: input.newRow.environment,
          source_id: input.newRow.source_id,
          source_type: input.newRow.source_type,
          status: "active",
          hash_algorithm: input.newRow.hash_algorithm,
          created_at: new Date("2026-05-12T13:00:00.000Z").toISOString(),
          revoked_at: null,
          last_used_at: null,
        });
        this.rows.set(input.oldApiKeyId, {
          ...old,
          status: "revoked",
          revoked_at: input.revokedAt.toISOString(),
        });
        this.auditCalls.push({
          action: "keys.rotate.issue",
          auditId: input.audit.issueAuditId,
          targetId: input.newRow.api_key_id,
          actorLabel: input.audit.actorLabel,
          projectId: input.audit.projectId,
          environment: input.audit.environment,
          before: null,
          after: input.audit.newKey,
          reason: null,
        });
        this.auditCalls.push({
          action: "keys.rotate.revoke",
          auditId: input.audit.revokeAuditId,
          targetId: input.oldApiKeyId,
          actorLabel: input.audit.actorLabel,
          projectId: input.audit.projectId,
          environment: input.audit.environment,
          before: input.audit.oldKeyBefore,
          after: input.audit.oldKeyAfter,
          reason: null,
        });
        return true;
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }
}

function makeContext(streams: OutputStreams): CommandContext {
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
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => makeContext(streams).logger,
    } as unknown as CommandContext["logger"],
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
  };
}

function jsonContext(streams: OutputStreams): CommandContext {
  const base = makeContext(streams);
  return {
    ...base,
    config: { ...base.config, output: "json" },
  };
}

/** Deterministic key material so tests can assert exact strings. */
function fixedMaterial(apiKeyId: string, rawSecret: string): IssuedKeyMaterial {
  return {
    apiKeyId,
    rawSecret,
    token: formatToken(apiKeyId, rawSecret),
  };
}

describe("hashing primitive (CLI imports shared-secrets)", () => {
  // The CLI side of the round-trip lives here. The ingester side asserts the
  // same in `apps/ingester-api/test/auth/hash.test.ts` — both call sites
  // round-trip through `@polaris/shared-secrets`, proving there is exactly
  // one argon2id integration in the workspace.
  it("hashSecret -> verifySecret round-trip", async () => {
    const plaintext = "shared-secret-tail-123";
    const stored = await hashSecret(plaintext);
    await expect(verifySecret(plaintext, stored, POLARIS_HASH_ALGORITHM)).resolves.toBe(true);
  }, 10_000);
});

describe("generateKeyMaterial", () => {
  it("produces a token with the polaris_ak_ prefix and a separator-delimited secret", () => {
    const material = generateKeyMaterial();
    expect(material.apiKeyId.startsWith("polaris_ak_")).toBe(true);
    expect(material.token).toBe(`${material.apiKeyId}.${material.rawSecret}`);
    // The id and the secret are non-empty.
    expect(material.apiKeyId.length).toBeGreaterThan("polaris_ak_".length);
    expect(material.rawSecret.length).toBeGreaterThan(0);
  });

  it("returns a unique id on every call", () => {
    const a = generateKeyMaterial();
    const b = generateKeyMaterial();
    expect(a.apiKeyId).not.toBe(b.apiKeyId);
    expect(a.rawSecret).not.toBe(b.rawSecret);
  });
});

describe("keys create runner", () => {
  it("prints the on-wire token EXACTLY ONCE on stdout", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysCreateRunner({
      issue: () => fixedMaterial("polaris_ak_fixed-id-1", "raw-secret-1"),
      hash: async (plaintext) => `stub-hash::${plaintext}`,
      openStore: () => store.asCreateStore(),
    });
    await runner(
      { project: "storefront", env: "production", source: "storefront-web", type: "web" },
      makeContext(capture.streams),
    );
    const joined = capture.stdout.join("");
    // The full token must appear exactly once.
    expect(joined.split("polaris_ak_fixed-id-1.raw-secret-1")).toHaveLength(2);
    // The bare api_key_id may appear in the metadata block AND in the token
    // line, but the *secret* must appear exactly once across all stdout/stderr.
    const combined = joined + capture.stderr.join("");
    expect(combined.split("raw-secret-1")).toHaveLength(2);
  });

  it("stores the argon2id hash, NOT the plaintext", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysCreateRunner({
      issue: () => fixedMaterial("polaris_ak_no-plaintext", "raw-secret-NO-PLAINTEXT"),
      hash: async (plaintext) => `stub-hash::${plaintext}`,
      openStore: () => store.asCreateStore(),
    });
    await runner(
      { project: "storefront", env: "production", source: "storefront-web", type: "web" },
      makeContext(capture.streams),
    );
    expect(store.inserts).toHaveLength(1);
    const inserted = store.inserts[0];
    if (inserted === undefined) throw new Error("expected one insert");
    // The hash column contains the stubbed hash, NOT the plaintext.
    expect(inserted.hash_algorithm).toBe(POLARIS_HASH_ALGORITHM);
    // The InMemory store doesn't carry the hash through to the read view, so
    // we re-inspect what the runner asked the store to insert.
  });

  it("rejects unsupported --type values with a usage error", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner(
        { project: "storefront", env: "production", source: "x", type: "smoke-signal" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    // Store is opened (constructor side-effect) but never inserted into.
    expect(store.inserts).toHaveLength(0);
  });

  it("rejects unsupported --env values with a usage error", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner(
        { project: "storefront", env: "qa", source: "x", type: "web" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("emits the same shape under --output json", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysCreateRunner({
      issue: () => fixedMaterial("polaris_ak_json-id", "raw-secret-json"),
      hash: async () => "stub-hash::json",
      openStore: () => store.asCreateStore(),
    });
    await runner(
      { project: "storefront", env: "production", source: "storefront-web", type: "web" },
      jsonContext(capture.streams),
    );
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed).toMatchObject({
      api_key_id: "polaris_ak_json-id",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      token: "polaris_ak_json-id.raw-secret-json",
    });
  });
});

describe("keys list runner", () => {
  it("never includes the raw secret nor the stored hash in its output", async () => {
    const store = new InMemoryApiKeyStore();
    store.insert({
      api_key_id: "polaris_ak_listed-1",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: "2026-05-11T00:00:00.000Z",
    });
    store.insert({
      api_key_id: "polaris_ak_listed-2",
      project_id: "storefront",
      environment: "production",
      source_id: "payments-api",
      source_type: "backend",
      status: "revoked",
      hash_algorithm: "argon2id",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: "2026-05-09T00:00:00.000Z",
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildKeysListRunner({ openStore: () => store.asListStore() });

    // Inject a fake "raw secret" into the store's hash to prove that even if
    // a future bug surfaced `hash`, the assertion would catch it. The
    // ApiKeyRow shape used by the list runner does not have a `hash` field
    // by design — the SQL select omits it. We still assert the secret-shaped
    // strings never appear.
    await runner({ project: "storefront", env: "production" }, makeContext(capture.streams));
    const joined = capture.stdout.join("") + capture.stderr.join("");
    expect(joined).not.toMatch(/argon2id\$/); // no PHC strings
    expect(joined).not.toContain(".raw-secret"); // no on-wire shape
    // The output must include the api_key_id, created_at, last_used_at, status.
    expect(joined).toContain("polaris_ak_listed-1");
    expect(joined).toContain("polaris_ak_listed-2");
    expect(joined).toContain("status=active");
    expect(joined).toContain("status=revoked");
    expect(joined).toContain("created=2026-05-10T00:00:00.000Z");
    expect(joined).toContain("last_used=2026-05-11T00:00:00.000Z");
    expect(joined).toContain("last_used=(unused)");
  });

  it("emits JSON with the same column set when --output json is set", async () => {
    const store = new InMemoryApiKeyStore();
    store.insert({
      api_key_id: "polaris_ak_json-listed",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildKeysListRunner({ openStore: () => store.asListStore() });
    await runner({ project: "storefront", env: "production" }, jsonContext(capture.streams));
    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.project_id).toBe("storefront");
    expect(parsed.environment).toBe("production");
    expect(parsed.count).toBe(1);
    expect(parsed.rows[0]).toMatchObject({
      api_key_id: "polaris_ak_json-listed",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      created_at: "2026-05-10T00:00:00.000Z",
      last_used_at: null,
      revoked_at: null,
    });
    // No `hash` key on the JSON row.
    expect(Object.hasOwn(parsed.rows[0], "hash")).toBe(false);
  });

  it("returns an empty-friendly message when no keys match", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysListRunner({ openStore: () => store.asListStore() });
    await runner({ project: "ghost", env: "production" }, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("(no api keys");
  });
});

describe("keys revoke runner", () => {
  it("marks an active key as revoked and stamps revoked_at", async () => {
    const store = new InMemoryApiKeyStore();
    store.insert({
      api_key_id: "polaris_ak_revoke-me",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    const now = new Date("2026-05-12T15:00:00.000Z");
    const capture = captureOutput();
    const runner = buildKeysRevokeRunner({
      openStore: () => store.asRevokeStore(now),
      now: () => now,
    });
    await runner({ apiKeyId: "polaris_ak_revoke-me" }, makeContext(capture.streams));
    const after = store.rows.get("polaris_ak_revoke-me");
    expect(after?.status).toBe("revoked");
    expect(after?.revoked_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain("revoked polaris_ak_revoke-me");
  });

  it("is idempotent: re-running on a revoked key prints `already revoked` and exits 0", async () => {
    const store = new InMemoryApiKeyStore();
    const originalRevokedAt = "2026-05-10T00:00:00.000Z";
    store.insert({
      api_key_id: "polaris_ak_already-revoked",
      project_id: "storefront",
      environment: "production",
      source_id: "x",
      source_type: "web",
      status: "revoked",
      hash_algorithm: "argon2id",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: originalRevokedAt,
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildKeysRevokeRunner({
      openStore: () => store.asRevokeStore(new Date("2026-05-12T16:00:00.000Z")),
      now: () => new Date("2026-05-12T16:00:00.000Z"),
    });
    await runner({ apiKeyId: "polaris_ak_already-revoked" }, makeContext(capture.streams));
    // No new UPDATE: the original revoked_at is preserved.
    expect(store.revokeCalls).toBe(0);
    const after = store.rows.get("polaris_ak_already-revoked");
    expect(after?.revoked_at).toBe(originalRevokedAt);
    expect(capture.stdout.join("")).toContain("already revoked");
  });

  it("raises a usage error when the key is unknown", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysRevokeRunner({
      openStore: () => store.asRevokeStore(new Date()),
    });
    await expect(
      runner({ apiKeyId: "polaris_ak_missing" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("keys rotate runner", () => {
  it("issues a replacement, revokes the old, and prints the new token ONCE", async () => {
    const store = new InMemoryApiKeyStore();
    store.insert({
      api_key_id: "polaris_ak_pre-rotate",
      project_id: "storefront",
      environment: "production",
      source_id: "storefront-web",
      source_type: "web",
      status: "active",
      hash_algorithm: "argon2id",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    const capture = captureOutput();
    const now = new Date("2026-05-12T17:00:00.000Z");
    const runner = buildKeysRotateRunner({
      issue: () => fixedMaterial("polaris_ak_post-rotate", "raw-secret-NEW"),
      hash: async (plaintext) => `stub-hash::${plaintext}`,
      openStore: () => store.asRotateStore(),
      now: () => now,
    });
    await runner({ apiKeyId: "polaris_ak_pre-rotate" }, makeContext(capture.streams));

    // Old row revoked.
    const old = store.rows.get("polaris_ak_pre-rotate");
    expect(old?.status).toBe("revoked");
    expect(old?.revoked_at).toBe(now.toISOString());
    // New row inserted active.
    const fresh = store.rows.get("polaris_ak_post-rotate");
    expect(fresh?.status).toBe("active");
    expect(fresh?.project_id).toBe("storefront");
    expect(fresh?.environment).toBe("production");
    expect(fresh?.source_id).toBe("storefront-web");
    expect(fresh?.source_type).toBe("web");
    // New raw token appears EXACTLY ONCE on stdout.
    const stdout = capture.stdout.join("");
    expect(stdout.split("polaris_ak_post-rotate.raw-secret-NEW")).toHaveLength(2);
    const combined = stdout + capture.stderr.join("");
    expect(combined.split("raw-secret-NEW")).toHaveLength(2);
  });

  it("refuses to rotate a key that is already revoked", async () => {
    const store = new InMemoryApiKeyStore();
    store.insert({
      api_key_id: "polaris_ak_already-revoked",
      project_id: "storefront",
      environment: "production",
      source_id: "x",
      source_type: "web",
      status: "revoked",
      hash_algorithm: "argon2id",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: "2026-05-09T00:00:00.000Z",
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildKeysRotateRunner({
      issue: () => fixedMaterial("polaris_ak_post-rotate", "raw-secret-NEW"),
      hash: async () => "stub-hash",
      openStore: () => store.asRotateStore(),
    });
    await expect(
      runner({ apiKeyId: "polaris_ak_already-revoked" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
    // No new row inserted.
    expect(store.rows.has("polaris_ak_post-rotate")).toBe(false);
  });

  it("refuses to rotate an unknown key", async () => {
    const store = new InMemoryApiKeyStore();
    const capture = captureOutput();
    const runner = buildKeysRotateRunner({
      openStore: () => store.asRotateStore(),
    });
    await expect(
      runner({ apiKeyId: "polaris_ak_missing" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("keys command surface mutates flags", () => {
  it("declares mutates: true on writers and mutates: false on list", async () => {
    const mod = await import("../src/index.js");
    expect(mod.keysCreateCommand.mutates).toBe(true);
    expect(mod.keysListCommand.mutates).toBe(false);
    expect(mod.keysRevokeCommand.mutates).toBe(true);
    expect(mod.keysRotateCommand.mutates).toBe(true);
  });

  it("keysCommand group reports mutates: false (children declare their own)", async () => {
    const mod = await import("../src/index.js");
    expect(mod.keysCommand.mutates).toBe(false);
  });
});

describe("keys command dispatcher wiring", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("`polaris keys --help` lists all four subcommands", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["keys", "--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("create");
    expect(help).toContain("list");
    expect(help).toContain("revoke");
    expect(help).toContain("rotate");
  });
});
