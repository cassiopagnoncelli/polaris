/**
 * Tests for the audited unit of work.
 *
 * The property under test is the one `docs/architecture/02-control-plane.md`
 * names as reason #1 the control-plane API exists: a mutation and its audit
 * row commit together or not at all. Three cases carry it:
 *
 *   - applied      -> exactly one audit row, inside the transaction
 *   - no-op        -> zero audit rows (the log records transitions, not clicks)
 *   - throw        -> zero audit rows, transaction rolled back
 *
 * A hand-rolled fake stands in for Kysely. A real-Postgres test would prove
 * rollback rather than merely the call sequence, and belongs in the
 * integration suite; this proves the logic that decides whether to write.
 */

import { readFile } from "node:fs/promises";
import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { type AuditContext, withAudit } from "../src/mutations/audited.js";

interface Recorded {
  readonly table: string;
  readonly values: Record<string, unknown>;
}

/**
 * Minimal stand-in for the slice of Kysely `withAudit` and `insertAuditRecord`
 * touch: `db.transaction().execute(cb)` and `trx.insertInto(t).values(v).execute()`.
 */
function fakeDb(options: { failCommit?: boolean } = {}): {
  db: Kysely<Database>;
  inserts: Recorded[];
  committed: boolean;
} {
  const inserts: Recorded[] = [];
  const state = { committed: false };

  const trx = {
    insertInto(table: string) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async execute() {
              inserts.push({ table, values });
            },
          };
        },
      };
    },
  };

  const db = {
    transaction() {
      return {
        async execute<T>(callback: (t: unknown) => Promise<T>): Promise<T> {
          const staged = inserts.length;
          try {
            const result = await callback(trx);
            if (options.failCommit === true) throw new Error("commit failed");
            state.committed = true;
            return result;
          } catch (err) {
            // Rollback: discard everything written inside the callback.
            inserts.length = staged;
            throw err;
          }
        },
      };
    },
  };

  return {
    db: db as unknown as Kysely<Database>,
    inserts,
    get committed() {
      return state.committed;
    },
  };
}

const AUDIT: AuditContext = {
  auditId: "polaris_aud_1",
  actorSource: "declared",
  actorLabel: "ops@example.com",
  reason: "vendor outage",
  requestId: "req_1",
  occurredAt: new Date("2026-08-11T10:00:00Z"),
};

const TARGET = {
  action: "destinations.disable",
  targetType: "destination",
  targetId: "polaris_dst_1",
  projectId: "storefront",
  environment: "production" as const,
  before: { status: "active" },
  after: { status: "disabled" },
};

describe("withAudit", () => {
  it("writes exactly one audit row when the mutation applies", async () => {
    const fake = fakeDb();
    const outcome = await withAudit(fake.db, AUDIT, TARGET, async () => true);

    expect(outcome).toEqual({ applied: true, auditId: "polaris_aud_1" });
    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]?.table).toBe("audit_records");
    expect(fake.inserts[0]?.values).toMatchObject({
      audit_id: "polaris_aud_1",
      actor_source: "declared",
      actor_label: "ops@example.com",
      action: "destinations.disable",
      target_type: "destination",
      target_id: "polaris_dst_1",
      project_id: "storefront",
      environment: "production",
      reason: "vendor outage",
      request_id: "req_1",
    });
  });

  it("writes NO audit row on a no-op transition", async () => {
    // A guarded UPDATE that matched nothing is not an event. Recording one
    // would make the audit log a click log, and re-running `disable` on an
    // already-disabled row would fabricate history.
    const fake = fakeDb();
    const outcome = await withAudit(fake.db, AUDIT, TARGET, async () => false);

    expect(outcome).toEqual({ applied: false, auditId: null });
    expect(fake.inserts).toHaveLength(0);
  });

  it("rolls the audit row back when the mutation throws", async () => {
    const fake = fakeDb();
    await expect(
      withAudit(fake.db, AUDIT, TARGET, async () => {
        throw new Error("constraint violation");
      }),
    ).rejects.toThrow("constraint violation");

    expect(fake.inserts).toHaveLength(0);
    expect(fake.committed).toBe(false);
  });

  it("leaves no audit row behind when the commit itself fails", async () => {
    const fake = fakeDb({ failCommit: true });
    await expect(withAudit(fake.db, AUDIT, TARGET, async () => true)).rejects.toThrow(
      "commit failed",
    );
    expect(fake.inserts).toHaveLength(0);
  });

  it("carries before/after snapshots onto the row", async () => {
    const fake = fakeDb();
    await withAudit(fake.db, AUDIT, TARGET, async () => true);
    expect(fake.inserts[0]?.values["before"]).toEqual({ status: "active" });
    expect(fake.inserts[0]?.values["after"]).toEqual({ status: "disabled" });
  });

  it("falls back to the audit id as request id, matching the CLI", async () => {
    // CLI invocations have no request, so they stamp request_id = audit_id.
    // The API passes its own UUIDv7 request id, which makes its rows joinable
    // against the service logs.
    const fake = fakeDb();
    const { requestId: _omitted, ...withoutRequestId } = AUDIT;
    await withAudit(fake.db, withoutRequestId, TARGET, async () => true);
    expect(fake.inserts[0]?.values["request_id"]).toBe("polaris_aud_1");
  });

  it("nulls optional audit fields rather than leaving them undefined", async () => {
    const fake = fakeDb();
    await withAudit(
      fake.db,
      { ...AUDIT, reason: null },
      { action: "a", targetType: "t", targetId: "id" },
      async () => true,
    );
    expect(fake.inserts[0]?.values).toMatchObject({
      project_id: null,
      environment: null,
      before: null,
      after: null,
      reason: null,
    });
  });
});

describe("DLQ resolution guard", () => {
  it("uses the same resolved_at IS NULL guard as the runtime repository", async () => {
    // Two implementations write this column: the runtime repository in
    // delivery-destinations (read-modify-write, returns the record) and the
    // audited mutation here (guarded UPDATE, returns applied). Both are
    // guarded identically, which is what makes having both safe — a second
    // resolve matches nothing either way. This pins the guard text so a
    // future edit that drops it is visible.
    const source = await readFile(new URL("../src/mutations/dlq.ts", import.meta.url), "utf8");
    const guards = source.match(/AND resolved_at IS NULL/g) ?? [];
    // Two, not three: the destination and processor resolves share one
    // helper, and the retry carries its own because its snapshot records the
    // redelivery queue as well.
    expect(guards).toHaveLength(2);
  });
});
