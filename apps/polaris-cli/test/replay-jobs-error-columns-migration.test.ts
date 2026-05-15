/**
 * Schema-invariant tests for the `replay_jobs` error-columns migration
 * (P7-003).
 *
 * The migration adds `error_class` and `error_message` to the
 * `replay_jobs` row so the executor can persist the cause when it marks
 * a row `failed`. The architectural rules baked into the migration are:
 *
 *   - Columns are NULLABLE so non-failed rows do not carry junk values.
 *   - A CHECK ties (`error_class IS NOT NULL`) to `status = 'failed'`,
 *     so the schema refuses to record an error on a non-failed row.
 *   - A CHECK ties `error_class` and `error_message` to each other —
 *     either both NULL or both NOT NULL.
 *   - Length bounds on both columns to keep the row stable.
 *   - A working `migrate:down` that drops both columns + every CHECK.
 *
 * The tests below parse the SQL text without spinning up a live
 * PostgreSQL.  If a future migration loosens any of these invariants,
 * the test fails LOUDLY rather than letting a partially-stamped error
 * row reach production.
 *
 * @see docs/implementation/tasks/P7-003-processor-replay-executor.md
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMigration(): string {
  const path = resolve(
    HERE,
    "../../../db/migrations/20260514000004_add_replay_jobs_error_columns.sql",
  );
  return readFileSync(path, "utf8");
}

describe("replay_jobs error-columns migration: schema invariants", () => {
  const sql = readMigration();

  it("adds error_class and error_message as nullable text columns", () => {
    expect(sql).toMatch(/ADD COLUMN\s+error_class\s+text/);
    expect(sql).toMatch(/ADD COLUMN\s+error_message\s+text/);
    // Neither column is NOT NULL — a non-failed row must be able to
    // sit with both columns NULL.
    expect(sql).not.toMatch(/ADD COLUMN\s+error_class\s+text\s+NOT NULL/);
    expect(sql).not.toMatch(/ADD COLUMN\s+error_message\s+text\s+NOT NULL/);
  });

  it("bounds error_class length to 128 chars when set", () => {
    expect(sql).toMatch(/replay_jobs_error_class_length/);
    expect(sql).toMatch(/length\(error_class\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(error_class\)\s*<=\s*128/);
  });

  it("bounds error_message length to 4096 chars when set", () => {
    expect(sql).toMatch(/replay_jobs_error_message_length/);
    expect(sql).toMatch(/length\(error_message\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(error_message\)\s*<=\s*4096/);
  });

  it("ties error_class and error_message together (both NULL or both NOT NULL)", () => {
    expect(sql).toMatch(/replay_jobs_error_columns_together/);
    expect(sql).toMatch(
      /error_class\s+IS\s+NULL\s+AND\s+error_message\s+IS\s+NULL[\s\S]+OR\s*\(\s*error_class\s+IS\s+NOT\s+NULL\s+AND\s+error_message\s+IS\s+NOT\s+NULL\s*\)/,
    );
  });

  it("only allows error_class to be set when status='failed'", () => {
    expect(sql).toMatch(/replay_jobs_error_only_when_failed/);
    expect(sql).toMatch(/error_class\s+IS\s+NULL[\s\S]+OR\s+status\s*=\s*'failed'/);
  });

  it("ships a working migrate:down that drops every constraint and column", () => {
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS replay_jobs_error_only_when_failed/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS replay_jobs_error_columns_together/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS replay_jobs_error_message_length/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS replay_jobs_error_class_length/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS error_message/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS error_class/);
  });
});
