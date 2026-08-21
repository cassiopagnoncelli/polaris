/**
 * Schema-invariant tests for the `processor_dlq_records` migration
 * (3L2HKMND).
 *
 * Mirrors the destination `dlq_records` migration test: parse the
 * SQL as text and assert the architectural invariants without
 * spinning up live PostgreSQL.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function readMigration(): string {
  return readFileSync(
    resolve(
      HERE,
      "../../../db/postgres/migrations/20260516000001_create_processor_dlq_records.sql",
    ),
    "utf8",
  );
}

describe("processor_dlq_records migration: schema invariants", () => {
  const sql = readMigration();

  it("creates the table", () => {
    expect(sql).toMatch(/CREATE TABLE processor_dlq_records/);
  });

  it("declares the columns the task card requires", () => {
    const required = [
      /\bdlq_id\s+text\s+PRIMARY KEY/,
      /\bprocessor_name\s+text\s+NOT NULL/,
      /\bprocessor_version\s+text\s+NOT NULL/,
      /\bevent_id\s+text\s+NOT NULL/,
      /\bevent_name\s+text\s+NOT NULL/,
      /\bproject_id\s+text\s+NOT NULL/,
      /\benvironment\s+text\s+NOT NULL/,
      /\battempts\s+integer\s+NOT NULL/,
      /\breason\s+text\s+NOT NULL/,
      /\berror_class\s+text\b/,
      /\berror_message\s+text\b/,
      /\bsource_topic\s+text\s+NOT NULL/,
      /\bsource_partition\s+integer\s+NOT NULL/,
      /\bsource_offset\s+text\s+NOT NULL/,
      /\bheaders\s+jsonb\s+NOT NULL/,
      /\bpayload\s+bytea\b/,
      /\bpublished_at\s+timestamptz\s+NOT NULL/,
      /\bresolved_at\s+timestamptz\b/,
      /\bresolved_by\s+text\b/,
      /\bresolution_note\s+text\b/,
      /\bcreated_at\s+timestamptz\s+NOT NULL/,
    ];
    for (const re of required) {
      expect(sql).toMatch(re);
    }
  });

  it("declares the resolved-consistency CHECK", () => {
    expect(sql).toMatch(/processor_dlq_records_resolved_consistent/);
    expect(sql).toMatch(/resolved_at IS NULL AND resolved_by IS NULL/);
  });

  it("creates the unresolved-triage partial index", () => {
    expect(sql).toMatch(/processor_dlq_records_processor_unresolved_idx/);
    expect(sql).toMatch(/WHERE resolved_at IS NULL/);
  });

  it("creates the event_id correlation index", () => {
    expect(sql).toMatch(/processor_dlq_records_event_id_idx/);
  });

  it("includes a complete migrate:down section", () => {
    expect(sql).toMatch(/-- migrate:down/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS processor_dlq_records/);
  });

  it("forbids columns that would imply storing secrets / plaintexts", () => {
    // Match the no-secret discipline the destination dlq_records
    // migration enforces — this column set should NEVER appear here.
    const forbidden = [
      /\bsecret\b/i,
      /\bbearer\b/i,
      /\bcredential\b/i,
      /\bauthorization\b/i,
      /\bprivate_key\b/i,
      /\bapi_key\b/i,
    ];
    for (const re of forbidden) {
      // Column declarations look like `<name> <type>` at line start
      // (we already saw the SQL has bytea `payload`, jsonb `headers`
      // — neither matches the forbidden tokens).
      expect(sql.match(re)).toBeNull();
    }
  });
});
