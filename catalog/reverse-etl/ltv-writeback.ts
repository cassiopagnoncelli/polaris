/**
 * `ltv_writeback` — writes a customer's lifetime order count back as a trait.
 *
 * The shipped example, and deliberately the simplest useful one: read an
 * aggregate the warehouse already maintains, and put it where activation
 * can reach it. Its correctness is checkable by hand.
 *
 * ## Why this is reverse ETL and not a computed trait
 *
 * A fair question, since `orders_30d` computes something similar without
 * leaving the platform. The difference is the direction of authority.
 * A computed trait is Polaris deriving a fact from its own event history;
 * a reverse-ETL job is Polaris accepting a fact from the WAREHOUSE, which
 * may have joined in data the platform never saw — a refunds table, a
 * subscription ledger, the finance team's definition of "lifetime".
 *
 * This example reads a Polaris projection because that is what a fresh
 * checkout has, and swapping the SQL for one that reads a joined view is
 * the whole point of the seam. What it demonstrates is the PATH, not the
 * arithmetic.
 *
 * ## Why `user.identified`
 *
 * It is the platform's trait-carrying event, and one of only three writers
 * of `profiles.traits`. Emitting it means the writeback goes through
 * exactly the same validation, policy, dedupe and identity resolution as a
 * trait an SDK reported — no second path, no second set of bugs.
 */

import { type ReverseEtlJob, type ReverseEtlRow, reverseEtlJobSchema } from "./types.js";

export const ltvWriteback: ReverseEtlJob = {
  ...reverseEtlJobSchema.parse({
    key: "ltv_writeback",
    version: 1,
    description: "Write lifetime completed-order count back as a profile trait",
    // Reads a projection, like every catalog SQL. `customer_id` rather than
    // `profile_id`: the event carries an IDENTITY, and letting the identity
    // stage resolve it is what keeps the writeback correct across a merge —
    // a profile id captured here would go stale the moment two profiles
    // became one.
    sql: `
      SELECT
          customer_id,
          toFloat64(sum(event_count)) AS lifetime_orders
      FROM polaris.profile_event_daily_counts
      WHERE project_id = {project:String}
        AND environment = {environment:String}
        AND event = 'order.completed'
        AND customer_id != ''
      GROUP BY customer_id
      HAVING lifetime_orders > 0
    `,
    toEvent: () => null,
  }),
  toEvent(row: ReverseEtlRow) {
    const customerId = row["customer_id"];
    if (typeof customerId !== "string" || customerId.trim().length === 0) return null;

    // ClickHouse returns Float64 as a JSON number, but a string is the
    // documented shape for some column types and settings. Coerced rather
    // than trusted: a trait that silently became the string "12" would
    // compare wrongly in every audience predicate that reads it.
    const orders = Number(row["lifetime_orders"]);
    if (!Number.isFinite(orders)) return null;

    return {
      event: "user.identified",
      customerId: customerId.trim(),
      // `user.identified` properties are passthrough beyond the well-known
      // slots, which is what makes a trait writeback expressible at all.
      properties: { lifetime_orders: orders },
    };
  },
};
