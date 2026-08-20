/**
 * Unit tests for the `polaris operators` command surface (P6-007).
 *
 * The runner factories accept hooks for store / hash / now so tests can drive
 * the runtime deterministically without a real PostgreSQL.
 *
 * Round-trip invariants (mirrors keys-commands.test.ts):
 *
 *   - Token format prefix is `polaris_ot_*` (greppable for secret detectors).
 *   - The raw token appears on stdout EXACTLY ONCE at create time.
 *   - The argon2id hash is stored; the plaintext is never persisted.
 *   - `operators list` view excludes the hash by construction.
 *
 * The mutates-flag assertions guarantee the production gate from P6-007
 * picks the right commands up.
 */
import { OPERATOR_TOKEN_ID_PREFIX, parseOperatorToken } from "@polaris/tenancy-control-plane";
import { POLARIS_HASH_ALGORITHM } from "@polaris/runtime-secrets";
import { describe, expect, it } from "vitest";

import {
  buildOperatorsCreateRunner,
  buildOperatorsListRunner,
  buildOperatorsRevokeRunner,
  type CommandContext,
  generateOperatorTokenMaterial,
  type IssuedOperatorTokenMaterial,
  type OperatorsCreateStore,
  type OperatorsListStore,
  type OperatorsRevokeStore,
  type OperatorTokenRow,
  type OutputStreams,
  type PackageMeta,
  type ResolvedActor,
} from "../src/index.js";

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  releaseLabel: undefined,
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

interface CapturedAuditCall {
  readonly action: string;
  readonly auditId: string;
  readonly targetId: string;
  readonly actorSource: string;
  readonly actorLabel: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
}

class InMemoryOperatorTokenStore {
  public readonly rows = new Map<string, OperatorTokenRow>();
  public readonly inserts: OperatorTokenRow[] = [];
  public readonly auditCalls: CapturedAuditCall[] = [];
  public closeCalls = 0;

  insert(row: OperatorTokenRow): void {
    this.rows.set(row.operator_token_id, row);
    this.inserts.push(row);
  }

  asCreateStore(): OperatorsCreateStore {
    return {
      insertWithAudit: async (input, audit) => {
        this.insert({
          operator_token_id: input.operator_token_id,
          operator_label: input.operator_label,
          hash_algorithm: input.hash_algorithm,
          status: "active",
          created_at: new Date("2026-05-12T12:00:00.000Z").toISOString(),
          revoked_at: null,
          last_used_at: null,
        });
        this.auditCalls.push({
          action: "operators.create",
          auditId: audit.auditId,
          targetId: input.operator_token_id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
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

  asListStore(): OperatorsListStore {
    return {
      list: async (statusFilter) => {
        const rows = [...this.rows.values()];
        if (statusFilter === undefined) return rows;
        return rows.filter((row) => row.status === statusFilter);
      },
      close: async () => {
        this.closeCalls += 1;
      },
    };
  }

  asRevokeStore(): OperatorsRevokeStore {
    return {
      findById: async (id) => this.rows.get(id) ?? null,
      revokeWithAudit: async (id, revokedAt, audit) => {
        const row = this.rows.get(id);
        if (row === undefined) return false;
        if (row.status !== "active") return false;
        this.rows.set(id, {
          ...row,
          status: "revoked",
          revoked_at: revokedAt.toISOString(),
        });
        this.auditCalls.push({
          action: "operators.revoke",
          auditId: audit.auditId,
          targetId: id,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
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
}

function makeContext(
  streams: OutputStreams,
  actor: ResolvedActor = { source: "cli", label: "cli" },
): CommandContext {
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
    actor,
  };
}

function fixedMaterial(operatorTokenId: string, rawSecret: string): IssuedOperatorTokenMaterial {
  return {
    operatorTokenId,
    rawSecret,
    token: `${operatorTokenId}.${rawSecret}`,
  };
}

describe("generateOperatorTokenMaterial", () => {
  it("produces tokens with the polaris_ot_ prefix and a separator-delimited secret", () => {
    const material = generateOperatorTokenMaterial();
    expect(material.operatorTokenId.startsWith(OPERATOR_TOKEN_ID_PREFIX)).toBe(true);
    expect(material.token).toBe(`${material.operatorTokenId}.${material.rawSecret}`);
    expect(material.operatorTokenId.length).toBeGreaterThan(OPERATOR_TOKEN_ID_PREFIX.length);
    expect(material.rawSecret.length).toBeGreaterThan(0);
    // Round-trip through the shared parser.
    const parsed = parseOperatorToken(material.token);
    expect(parsed).toEqual({
      operatorTokenId: material.operatorTokenId,
      rawSecret: material.rawSecret,
    });
  });

  it("returns a unique id and secret per call", () => {
    const a = generateOperatorTokenMaterial();
    const b = generateOperatorTokenMaterial();
    expect(a.operatorTokenId).not.toBe(b.operatorTokenId);
    expect(a.rawSecret).not.toBe(b.rawSecret);
  });
});

describe("operators create runner", () => {
  it("prints the on-wire token EXACTLY ONCE on stdout, never on stderr", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsCreateRunner({
      issue: () => fixedMaterial("polaris_ot_fixed-id-1", "raw-secret-1"),
      hash: async (plaintext) => `stub-hash::${plaintext}`,
      openStore: () => store.asCreateStore(),
    });
    await runner({ label: "alice@polaris.dev" }, makeContext(capture.streams));
    const joinedOut = capture.stdout.join("");
    // Full token appears exactly once on stdout.
    expect(joinedOut.split("polaris_ot_fixed-id-1.raw-secret-1")).toHaveLength(2);
    // Raw secret tail never appears on stderr; appears exactly once in
    // combined output (the one stdout write).
    const combined = joinedOut + capture.stderr.join("");
    expect(combined.split("raw-secret-1")).toHaveLength(2);
    // stderr is silent for a successful create.
    expect(capture.stderr.join("")).toBe("");
  });

  it("stores the argon2id hash, NOT the plaintext", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    let hashedPlaintext: string | undefined;
    const runner = buildOperatorsCreateRunner({
      issue: () => fixedMaterial("polaris_ot_no-plaintext", "raw-secret-NO-PLAINTEXT"),
      hash: async (plaintext) => {
        hashedPlaintext = plaintext;
        return `stub-hash::${plaintext}`;
      },
      openStore: () => store.asCreateStore(),
    });
    await runner({ label: "bob@polaris.dev" }, makeContext(capture.streams));
    expect(hashedPlaintext).toBe("raw-secret-NO-PLAINTEXT");
    expect(store.inserts).toHaveLength(1);
    const row = store.inserts[0];
    if (row === undefined) throw new Error("expected one insert");
    expect(row.hash_algorithm).toBe(POLARIS_HASH_ALGORITHM);
    expect(row.operator_label).toBe("bob@polaris.dev");
    // Insert payload doesn't carry plaintext.
    expect(JSON.stringify(row)).not.toContain("raw-secret-NO-PLAINTEXT");
  });

  it("inserts an audit row carrying the resolved actor", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsCreateRunner({
      issue: () => fixedMaterial("polaris_ot_audit-id", "secret"),
      hash: async () => "hash::audit",
      openStore: () => store.asCreateStore(),
      generateAuditId: () => "FIXED-AUDIT-ID",
    });
    const declaredActor: ResolvedActor = {
      source: "declared",
      label: "alice@polaris.dev",
      tokenId: "polaris_ot_alice-rec",
    };
    await runner({ label: "bob@polaris.dev" }, makeContext(capture.streams, declaredActor));
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("operators.create");
    expect(audit.auditId).toBe("FIXED-AUDIT-ID");
    expect(audit.targetId).toBe("polaris_ot_audit-id");
    expect(audit.actorSource).toBe("declared");
    expect(audit.actorLabel).toBe("alice@polaris.dev");
    expect(audit.after).toMatchObject({
      operator_token_id: "polaris_ot_audit-id",
      operator_label: "bob@polaris.dev",
      status: "active",
      hash_algorithm: POLARIS_HASH_ALGORITHM,
      revoked_at: null,
    });
  });

  it("rejects an empty --label", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(runner({ label: "  " }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
    expect(store.inserts).toHaveLength(0);
  });

  it("rejects an oversized --label", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsCreateRunner({
      openStore: () => store.asCreateStore(),
    });
    await expect(
      runner({ label: "x".repeat(257) }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("operators list runner", () => {
  it("never includes the raw token nor the stored hash in its output", async () => {
    const store = new InMemoryOperatorTokenStore();
    store.insert({
      operator_token_id: "polaris_ot_listed-1",
      operator_label: "alice@polaris.dev",
      hash_algorithm: "argon2id",
      status: "active",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: "2026-05-11T00:00:00.000Z",
    });
    store.insert({
      operator_token_id: "polaris_ot_listed-2",
      operator_label: "bob@polaris.dev",
      hash_algorithm: "argon2id",
      status: "revoked",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: "2026-05-09T00:00:00.000Z",
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildOperatorsListRunner({ openStore: () => store.asListStore() });
    await runner({}, makeContext(capture.streams));
    const joined = capture.stdout.join("") + capture.stderr.join("");
    // No PHC strings or `.<secret>` shapes.
    expect(joined).not.toMatch(/argon2id\$/);
    expect(joined).not.toMatch(/polaris_ot_listed-1\./);
    expect(joined).toContain("polaris_ot_listed-1");
    expect(joined).toContain("polaris_ot_listed-2");
    expect(joined).toContain("status=active");
    expect(joined).toContain("status=revoked");
    expect(joined).toContain("label=alice@polaris.dev");
    expect(joined).toContain("label=bob@polaris.dev");
  });

  it("filters to active rows when --status active is passed", async () => {
    const store = new InMemoryOperatorTokenStore();
    store.insert({
      operator_token_id: "polaris_ot_active",
      operator_label: "alice@polaris.dev",
      hash_algorithm: "argon2id",
      status: "active",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    store.insert({
      operator_token_id: "polaris_ot_revoked",
      operator_label: "bob@polaris.dev",
      hash_algorithm: "argon2id",
      status: "revoked",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: "2026-05-09T00:00:00.000Z",
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildOperatorsListRunner({ openStore: () => store.asListStore() });
    await runner({ status: "active" }, makeContext(capture.streams));
    const joined = capture.stdout.join("");
    expect(joined).toContain("polaris_ot_active");
    expect(joined).not.toContain("polaris_ot_revoked");
  });

  it("rejects an unknown --status value", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsListRunner({ openStore: () => store.asListStore() });
    await expect(runner({ status: "ghost" }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("renders an empty-friendly message when no tokens match", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsListRunner({ openStore: () => store.asListStore() });
    await runner({}, makeContext(capture.streams));
    expect(capture.stdout.join("")).toContain("(no operator tokens");
  });
});

describe("operators revoke runner", () => {
  it("marks an active token as revoked, stamps revoked_at, persists audit", async () => {
    const store = new InMemoryOperatorTokenStore();
    store.insert({
      operator_token_id: "polaris_ot_revoke-me",
      operator_label: "alice@polaris.dev",
      hash_algorithm: "argon2id",
      status: "active",
      created_at: "2026-05-10T00:00:00.000Z",
      revoked_at: null,
      last_used_at: null,
    });
    const now = new Date("2026-05-12T15:00:00.000Z");
    const capture = captureOutput();
    const runner = buildOperatorsRevokeRunner({
      openStore: () => store.asRevokeStore(),
      now: () => now,
      generateAuditId: () => "FIXED-REVOKE-ID",
    });
    await runner(
      { operatorTokenId: "polaris_ot_revoke-me", reason: "user offboarded" },
      makeContext(capture.streams),
    );
    const after = store.rows.get("polaris_ot_revoke-me");
    expect(after?.status).toBe("revoked");
    expect(after?.revoked_at).toBe(now.toISOString());
    expect(capture.stdout.join("")).toContain("revoked polaris_ot_revoke-me");
    expect(store.auditCalls).toHaveLength(1);
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(audit.action).toBe("operators.revoke");
    expect(audit.targetId).toBe("polaris_ot_revoke-me");
    expect(audit.actorSource).toBe("cli");
    expect(audit.actorLabel).toBe("cli");
    expect(audit.reason).toBe("user offboarded");
  });

  it("is idempotent: re-running on a revoked token prints `already revoked` and exits 0", async () => {
    const store = new InMemoryOperatorTokenStore();
    const originalRevokedAt = "2026-05-10T00:00:00.000Z";
    store.insert({
      operator_token_id: "polaris_ot_already-revoked",
      operator_label: "alice@polaris.dev",
      hash_algorithm: "argon2id",
      status: "revoked",
      created_at: "2026-05-08T00:00:00.000Z",
      revoked_at: originalRevokedAt,
      last_used_at: null,
    });
    const capture = captureOutput();
    const runner = buildOperatorsRevokeRunner({
      openStore: () => store.asRevokeStore(),
      now: () => new Date("2026-05-12T16:00:00.000Z"),
    });
    await runner({ operatorTokenId: "polaris_ot_already-revoked" }, makeContext(capture.streams));
    const after = store.rows.get("polaris_ot_already-revoked");
    expect(after?.revoked_at).toBe(originalRevokedAt);
    expect(capture.stdout.join("")).toContain("already revoked");
    expect(store.auditCalls).toHaveLength(0);
  });

  it("raises a usage error when the token is unknown", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsRevokeRunner({
      openStore: () => store.asRevokeStore(),
    });
    await expect(
      runner({ operatorTokenId: "polaris_ot_missing" }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("rejects an oversized --reason", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsRevokeRunner({
      openStore: () => store.asRevokeStore(),
    });
    await expect(
      runner(
        { operatorTokenId: "polaris_ot_x", reason: "x".repeat(1025) },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("operators command surface mutates flags", () => {
  it("declares mutates: true on writers and mutates: false on list", async () => {
    const mod = await import("../src/index.js");
    expect(mod.operatorsCreateCommand.mutates).toBe(true);
    expect(mod.operatorsListCommand.mutates).toBe(false);
    expect(mod.operatorsRevokeCommand.mutates).toBe(true);
  });

  it("operatorsCommand group reports mutates: false (children declare their own)", async () => {
    const mod = await import("../src/index.js");
    expect(mod.operatorsCommand.mutates).toBe(false);
  });
});

describe("token plaintext never appears in audit payloads", () => {
  it("does not include the raw secret in the audit row's `after` snapshot", async () => {
    const store = new InMemoryOperatorTokenStore();
    const capture = captureOutput();
    const runner = buildOperatorsCreateRunner({
      issue: () => fixedMaterial("polaris_ot_safe", "raw-secret-CONFIDENTIAL"),
      hash: async () => "hash::ok",
      openStore: () => store.asCreateStore(),
    });
    await runner({ label: "alice@polaris.dev" }, makeContext(capture.streams));
    const audit = store.auditCalls[0];
    if (audit === undefined) throw new Error("expected one audit call");
    expect(JSON.stringify(audit)).not.toContain("raw-secret-CONFIDENTIAL");
  });
});
