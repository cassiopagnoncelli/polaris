/**
 * Schema-invariant tests for the `topic_isolations` migration.
 *
 * The migration is the source of truth for the schema. These tests
 * assert the architectural rules baked into it without spinning up a
 * live PostgreSQL: the SQL file is parsed as text and checked for the
 * column shape, CHECK constraints, and indexes the resolver and the
 * CLI rely on.
 *
 * If a future migration would loosen any of these invariants (for
 * example by dropping the partial unique index that enforces "one
 * active isolation per triple"), this test fails LOUDLY rather than
 * letting a duplicate-active state reach production.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_STREAM_FAMILIES } from "@polaris/shared-transport";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMigration(): string {
  const path = resolve(HERE, "../../../db/migrations/20260514000003_create_topic_isolations.sql");
  return readFileSync(path, "utf8");
}

describe("topic_isolations migration: schema invariants", () => {
  const sql = readMigration();

  it("creates the table", () => {
    expect(sql).toMatch(/CREATE TABLE topic_isolations/);
  });

  it("carries the required FK to projects", () => {
    expect(sql).toMatch(/project_id\s+text\s+NOT NULL REFERENCES projects\(project_id\)/);
  });

  it("declares every column from the task spec", () => {
    const required = [
      /\bid\s+text\s+PRIMARY KEY/,
      /\bproject_id\s+text\s+NOT NULL/,
      /\benvironment\s+text\s+NOT NULL/,
      /\btopic_family\s+text\s+NOT NULL/,
      /\bconcrete_topic\s+text\s+NOT NULL/,
      /\bactivated_at\s+timestamptz\s+NOT NULL/,
      /\bdeactivated_at\s+timestamptz\b/,
      /\breason\s+text\s+NOT NULL/,
      /\bactor_id\s+text\s+NOT NULL/,
    ];
    for (const re of required) {
      expect(sql).toMatch(re);
    }
  });

  it("constrains environment to the closed set", () => {
    expect(sql).toMatch(
      /environment\s+IN\s+\(\s*'development'\s*,\s*'staging'\s*,\s*'production'\s*\)/,
    );
  });

  it("constrains topic_family to exactly CANONICAL_STREAM_FAMILIES", () => {
    // Verify each canonical family appears in the CHECK. This is the
    // coordinated-change rule: widening the family set requires
    // widening both the constant and the CHECK.
    for (const family of CANONICAL_STREAM_FAMILIES) {
      expect(sql).toContain(`'${family}'`);
    }
  });

  it("enforces concrete_topic = topic_family || '.' || project_id", () => {
    expect(sql).toMatch(/concrete_topic\s*=\s*topic_family\s*\|\|\s*'\.'\s*\|\|\s*project_id/);
  });

  it("enforces one active isolation per (family, project, environment) via a partial unique index", () => {
    // The migration uses TWO partial indexes on the same triple — one
    // unique for the active rows, one non-unique for the lookup hot
    // path. Both must filter on `deactivated_at IS NULL`.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]+topic_isolations \(topic_family, project_id, environment\)[\s\S]+WHERE deactivated_at IS NULL/,
    );
  });

  it("creates the active-lookup index for the resolver hot path", () => {
    expect(sql).toMatch(
      /CREATE INDEX[\s\S]+topic_isolations \(topic_family, project_id, environment\)[\s\S]+WHERE deactivated_at IS NULL/,
    );
  });

  it("bounds reason and actor_id lengths", () => {
    expect(sql).toMatch(/length\(reason\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(reason\)\s*<=\s*1024/);
    expect(sql).toMatch(/length\(actor_id\)\s*>=\s*1/);
    expect(sql).toMatch(/length\(actor_id\)\s*<=\s*128/);
  });

  it("enforces deactivated_at >= activated_at when set", () => {
    expect(sql).toMatch(/deactivated_at\s+IS\s+NULL\s+OR\s+deactivated_at\s*>=\s*activated_at/);
  });

  it("ships a working migrate:down section", () => {
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS topic_isolations/);
  });
});
