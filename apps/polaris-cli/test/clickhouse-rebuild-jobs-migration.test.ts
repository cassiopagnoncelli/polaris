/**
 * Schema-invariant tests for the `clickhouse_rebuild_jobs` migration.
 *
 * The migration is the source of truth for the schema. These tests
 * assert the architectural rules baked into it without spinning up a
 * live PostgreSQL: the SQL file is parsed as text and checked for the
 * column shape, CHECK constraints, indexes, and forbidden columns the
 * planner and CLI rely on.
 *
 * If a future migration would loosen any of these invariants (for
 * example by dropping the `error_class IS NOT NULL ↔ status='failed'`
 * CHECK), this test fails LOUDLY rather than letting an inconsistent
 * row reach production.
 *
 * @see db/migrations/20260515000001_create_clickhouse_rebuild_jobs.sql
 * @see docs/implementation/tasks/P7-005-clickhouse-rebuild-workflows.md
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CLICKHOUSE_REBUILD_JOB_STATUSES } from "../src/db/clickhouse-rebuild-jobs.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMigration(): string {
  const path = resolve(
    HERE,
    "../../../db/migrations/20260515000001_create_clickhouse_rebuild_jobs.sql",
  );
  return readFileSync(path, "utf8");
}

describe("clickhouse_rebuild_jobs migration: schema invariants", () => {
  const sql = readMigration();

  it("creates the table", () => {
    expect(sql).toMatch(/CREATE TABLE clickhouse_rebuild_jobs/);
  });

  it("encodes the polaris_chr_ prefix CHECK", () => {
    expect(sql).toMatch(/clickhouse_rebuild_jobs_id_format/);
    expect(sql).toMatch(/polaris_chr_/);
  });

  it("declares every column from the task spec", () => {
    const required = [
      /\bclickhouse_rebuild_job_id\s+text\s+PRIMARY KEY/,
      /\btarget_projection\s+text\s+NOT NULL/,
      /\btarget_table_qualified\s+text\s+NOT NULL/,
      /\bsource_range_from\s+timestamptz\b/,
      /\bsource_range_to\s+timestamptz\b/,
      /\breason\s+text\s+NOT NULL/,
      /\brequester_actor_label\s+text\s+NOT NULL/,
      /\bstatus\s+text\s+NOT NULL DEFAULT 'pending'/,
      /\brows_estimated\s+bigint\b/,
      /\bpartitions_estimated\s+integer\b/,
      /\berror_class\s+text\b/,
      /\berror_message\s+text\b/,
      /\bcreated_at\s+timestamptz\s+NOT NULL/,
      /\bupdated_at\s+timestamptz\s+NOT NULL/,
      /\bstarted_at\s+timestamptz\b/,
      /\bcompleted_at\s+timestamptz\b/,
    ];
    for (const re of required) {
      expect(sql).toMatch(re);
    }
  });

  it("constrains target_table_qualified to the polaris.<table> prefix", () => {
    expect(sql).toMatch(/target_table_qualified ~ '\^polaris\\\.\[a-z\]/);
  });

  it("constrains status to exactly the closed set the CLI exports", () => {
    // The CHECK lists every status; the CLI's CLICKHOUSE_REBUILD_JOB_STATUSES
    // is the typed mirror.
    for (const status of CLICKHOUSE_REBUILD_JOB_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it("enforces the error-pair CHECK (both NULL or both NOT NULL)", () => {
    expect(sql).toMatch(/clickhouse_rebuild_jobs_error_pair/);
    expect(sql).toMatch(
      /\(error_class IS NULL AND error_message IS NULL\)\s*OR\s*\(error_class IS NOT NULL AND error_message IS NOT NULL\)/,
    );
  });

  it("enforces error_class IS NOT NULL ↔ status='failed'", () => {
    expect(sql).toMatch(/clickhouse_rebuild_jobs_error_status_consistent/);
    expect(sql).toMatch(/error_class IS NULL\s+AND\s+status\s*<>\s*'failed'/);
    expect(sql).toMatch(/error_class IS NOT NULL\s+AND\s+status\s*=\s*'failed'/);
  });

  it("enforces range pairing (both NULL or both NOT NULL)", () => {
    expect(sql).toMatch(/clickhouse_rebuild_jobs_range_paired/);
    expect(sql).toMatch(/source_range_from IS NULL\s+AND\s+source_range_to IS NULL/);
  });

  it("enforces source_range_to >= source_range_from when set", () => {
    expect(sql).toMatch(/source_range_to\s*>=\s*source_range_from/);
  });

  it("creates the two backing indexes", () => {
    expect(sql).toMatch(/clickhouse_rebuild_jobs_status_created_idx/);
    expect(sql).toMatch(/clickhouse_rebuild_jobs_projection_created_idx/);
    expect(sql).toMatch(/CREATE INDEX[^;]+clickhouse_rebuild_jobs \(status, created_at DESC\)/);
    expect(sql).toMatch(
      /CREATE INDEX[^;]+clickhouse_rebuild_jobs \(target_projection, created_at DESC\)/,
    );
  });

  it("bounds reason and requester_actor_label lengths", () => {
    expect(sql).toMatch(/length\(reason\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(reason\)\s*<=\s*1024/);
    expect(sql).toMatch(/length\(requester_actor_label\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(requester_actor_label\)\s*<=\s*256/);
  });

  it("has NO executor-side / planner-semantic columns", () => {
    // The migration deliberately does NOT carry partition strategy,
    // batch size, replica routing, or transform-override slots.
    // Those live in code (the planner package); rolling forward a
    // schema migration to add them would be a bug.
    const executable = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const forbidden = [
      "partition_strategy",
      "partitioning",
      "batch_strategy",
      "batch_size",
      "chunk_strategy",
      "transform_override",
      "field_map",
      "replica_target",
      "destination_topic",
      "input_topic",
    ];
    for (const column of forbidden) {
      expect(executable, `forbidden column found: ${column}`).not.toMatch(
        new RegExp(`\\b${column}\\b`),
      );
    }
  });

  it("never carries a credential-shaped column", () => {
    const executable = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const banned = ["plaintext", "password", "secret", "token", "api_key", "private_key"];
    for (const word of banned) {
      expect(executable, `banned credential column found: ${word}`).not.toMatch(
        new RegExp(`^\\s*${word}\\s+(text|varchar|jsonb)`, "m"),
      );
    }
  });

  it("ships a working migrate:down section that drops indexes + table", () => {
    expect(sql).toMatch(/-- migrate:up/);
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS clickhouse_rebuild_jobs_status_created_idx/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS clickhouse_rebuild_jobs_projection_created_idx/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS clickhouse_rebuild_jobs/);
  });
});
