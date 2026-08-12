import { POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import { describe, expect, it } from "vitest";

import {
  CLI_FALLBACK_LABEL,
  OPERATOR_TOKEN_ENV_VAR,
  type OperatorTokenRepository,
  type OperatorTokenRow,
  resolveActor,
} from "../src/index.js";

interface StubRepoOptions {
  readonly rows?: readonly OperatorTokenRow[];
  readonly findError?: Error;
  readonly touchError?: Error;
}

class StubRepository implements OperatorTokenRepository {
  public readonly findCalls: string[] = [];
  public readonly touchCalls: Array<{ id: string; at: Date }> = [];
  private readonly rows: Map<string, OperatorTokenRow>;
  private readonly findError: Error | undefined;
  private readonly touchError: Error | undefined;

  constructor(options: StubRepoOptions = {}) {
    this.rows = new Map();
    for (const row of options.rows ?? []) {
      this.rows.set(row.operator_token_id, row);
    }
    this.findError = options.findError;
    this.touchError = options.touchError;
  }

  async findById(id: string): Promise<OperatorTokenRow | null> {
    this.findCalls.push(id);
    if (this.findError !== undefined) throw this.findError;
    return this.rows.get(id) ?? null;
  }

  async touchLastUsedAt(id: string, at: Date): Promise<void> {
    this.touchCalls.push({ id, at });
    if (this.touchError !== undefined) throw this.touchError;
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

describe("resolveActor fallback to source=cli", () => {
  it("returns cli when POLARIS_OPERATOR_TOKEN is absent", async () => {
    const repo = new StubRepository();
    const actor = await resolveActor({ env: {}, repository: repo });
    expect(actor).toEqual({ source: "cli", label: CLI_FALLBACK_LABEL });
    expect(repo.findCalls).toHaveLength(0);
  });

  it("returns cli when the env var is empty / whitespace", async () => {
    const repo = new StubRepository();
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "   " },
      repository: repo,
    });
    expect(actor.source).toBe("cli");
    expect(repo.findCalls).toHaveLength(0);
  });

  it("returns cli when the token shape is invalid (no DB call)", async () => {
    const repo = new StubRepository();
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "not-a-polaris-token" },
      repository: repo,
    });
    expect(actor.source).toBe("cli");
    expect(repo.findCalls).toHaveLength(0);
  });

  it("returns cli when the row is unknown", async () => {
    const repo = new StubRepository();
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_unknown.secret-tail" },
      repository: repo,
      verify: async () => true,
    });
    expect(actor.source).toBe("cli");
    expect(repo.findCalls).toEqual(["polaris_ot_unknown"]);
  });

  it("returns cli when the row is revoked", async () => {
    const repo = new StubRepository({ rows: [revokedRow] });
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_revoked.secret-tail" },
      repository: repo,
      verify: async () => true,
    });
    expect(actor.source).toBe("cli");
    expect(repo.touchCalls).toHaveLength(0);
  });

  it("returns cli when the hash algorithm does not match", async () => {
    const repo = new StubRepository({
      rows: [{ ...activeRow, hash_algorithm: "bcrypt" }],
    });
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_active.secret-tail" },
      repository: repo,
      verify: async () => true,
    });
    expect(actor.source).toBe("cli");
    expect(repo.touchCalls).toHaveLength(0);
  });

  it("returns cli when the secret tail fails verification", async () => {
    const repo = new StubRepository({ rows: [activeRow] });
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_active.wrong-secret" },
      repository: repo,
      verify: async () => false,
    });
    expect(actor.source).toBe("cli");
    expect(repo.touchCalls).toHaveLength(0);
  });
});

describe("resolveActor success path", () => {
  it("returns operator_token with the row label + tokenId on a verified active row", async () => {
    const repo = new StubRepository({ rows: [activeRow] });
    const fixedNow = new Date("2026-05-12T18:00:00.000Z");
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_active.secret-tail" },
      repository: repo,
      verify: async (plaintext, hash) => plaintext === "secret-tail" && hash === activeRow.hash,
      now: () => fixedNow,
    });
    expect(actor).toEqual({
      source: "operator_token",
      label: "alice@polaris.dev",
      tokenId: "polaris_ot_active",
    });
    expect(repo.touchCalls).toEqual([{ id: "polaris_ot_active", at: fixedNow }]);
  });

  it("swallows touch errors so a transient outage doesn't block the command", async () => {
    const repo = new StubRepository({
      rows: [activeRow],
      touchError: new Error("DB unreachable"),
    });
    const actor = await resolveActor({
      env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_active.secret-tail" },
      repository: repo,
      verify: async () => true,
    });
    expect(actor.source).toBe("operator_token");
    expect(actor.label).toBe("alice@polaris.dev");
  });
});

describe("resolveActor surfaces infrastructure failures from findById", () => {
  it("does NOT swallow a DB lookup error", async () => {
    const repo = new StubRepository({ findError: new Error("DB unreachable") });
    await expect(
      resolveActor({
        env: { [OPERATOR_TOKEN_ENV_VAR]: "polaris_ot_active.secret-tail" },
        repository: repo,
      }),
    ).rejects.toThrow(/DB unreachable/);
  });
});
