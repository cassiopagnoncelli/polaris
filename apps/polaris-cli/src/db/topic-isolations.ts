/**
 * Kysely-backed `ScopedIsolationLookup` adapter.
 *
 * Deliberately left behind when the rest of `topic-isolations` moved into
 * `@polaris/persistence-control-plane`. This is the runtime hot path — the
 * transport layer's per-message "is this project isolated?" question — not a
 * control-plane concern, and it is the only part that needs
 * `@polaris/bus`. Moving it would have put amqplib in the
 * dependency tree of every control-plane consumer, including a service that
 * deliberately speaks to no broker.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { ScopedIsolationLookup } from "@polaris/bus";
import type { Kysely } from "kysely";

/**
 * Build a Kysely-backed {@link ScopedIsolationLookup} adapter. The
 * adapter answers "is `(family, project_id, environment)` currently
 * isolated?" against the `topic_isolations` table; production callers
 * stack a `StreamIsolationCache` (from `@polaris/bus`) on top
 * so the per-publish PostgreSQL round trip is amortized to one query
 * per TTL window.
 *
 * The adapter selects only the FK columns it needs and applies the
 * partial-active filter on every read; the table's
 * `topic_isolations_active_lookup_idx` covers the query.
 */
export function createKyselyScopedIsolationLookup(db: Kysely<Database>): ScopedIsolationLookup {
  return {
    async isIsolated(family, projectId, environment): Promise<boolean> {
      const row = await db
        .selectFrom("topic_isolations")
        .select(["id"])
        .where("topic_family", "=", family)
        .where("project_id", "=", projectId)
        .where("environment", "=", environment)
        .where("deactivated_at", "is", null)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
