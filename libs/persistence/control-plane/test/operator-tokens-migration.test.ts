/**
 * Schema-invariant tests for the `operator_tokens` migration.
 *
 * The migration is the source of truth for the schema. These tests assert
 * the architectural rules baked into it without spinning up a live
 * PostgreSQL: the SQL file is parsed as text and checked for forbidden
 * column shapes (plaintext / secret / token) and required column shapes
 * (hash, hash_algorithm, status, polaris_ot_ prefix CHECK).
 *
 * If a future migration would loosen any of these invariants, the test
 * fails LOUDLY rather than letting a leaked credential reach production.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMigration(): string {
  // The migration lives at the repo root, four levels above this test
  // file (apps/polaris-cli/test/<this>.ts → repo/db/migrations/...).
  const path = resolve(HERE, "../../../../db/migrations/20260512000009_create_operator_tokens.sql");
  return readFileSync(path, "utf8");
}

describe("operator_tokens migration: schema invariants", () => {
  const sql = readMigration();

  it("creates the table", () => {
    expect(sql).toMatch(/CREATE TABLE operator_tokens/);
  });

  it("stores the argon2id hash, NOT plaintext", () => {
    expect(sql).toMatch(/hash\s+text\s+NOT NULL/);
    expect(sql).toMatch(/hash_algorithm\s+text\s+NOT NULL DEFAULT 'argon2id'/);
  });

  it("has NO column resembling plaintext / secret / token / password", () => {
    // Match the column-declaration boundary explicitly so the prose comments
    // above (which DO mention these words to document the invariant) don't
    // false-trigger.
    //
    // Each banned name is only forbidden as a column declaration. The migration
    // intentionally names the primary key `operator_token_id` — that's NOT
    // a credential column, just an opaque public id.
    const columnDeclarationLines = sql
      .split("\n")
      .filter((line) => /^\s*[a-z_]+\s+(text|timestamptz|jsonb|integer|boolean|bigint)/i.test(line))
      .join("\n");

    expect(columnDeclarationLines).not.toMatch(/^\s*plaintext\s/m);
    expect(columnDeclarationLines).not.toMatch(/^\s*secret\s/m);
    expect(columnDeclarationLines).not.toMatch(/^\s*password\s/m);
    // `token` (bare) would be a credential value; `operator_token_id` is fine.
    expect(columnDeclarationLines).not.toMatch(/^\s*token\s+(text|varchar)/m);
  });

  it("constrains status to a closed set ('active' | 'revoked')", () => {
    expect(sql).toMatch(/status\s+IN\s+\(\s*'active'\s*,\s*'revoked'\s*\)/);
  });

  it("constrains operator_token_id to the polaris_ot_ prefix", () => {
    expect(sql).toMatch(/operator_token_id ~ '\^polaris_ot_/);
  });

  it("constrains operator_label to a non-empty, bounded length", () => {
    expect(sql).toMatch(/length\(operator_label\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(operator_label\)\s*<=\s*256/);
  });

  it("creates the (status, last_used_at) and (operator_label, created_at) indexes", () => {
    expect(sql).toMatch(/CREATE INDEX[^;]+operator_tokens \(status, last_used_at DESC\)/);
    expect(sql).toMatch(/CREATE INDEX[^;]+operator_tokens \(operator_label, created_at DESC\)/);
  });

  it("ships a working migrate:down section", () => {
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS operator_tokens/);
  });
});
