/**
 * `orders_30d` — completed orders in the last 30 days.
 *
 * The shipped example, and deliberately the simplest useful one: it reads a
 * single projection, aggregates one event name, and its correctness is
 * checkable by hand. A first definition that showed off a window function
 * would teach the wrong lesson about what belongs in a trait.
 *
 * Reads `profile_event_daily_counts`, which is fed from `analytics_raw` by
 * a materialized view — so the trait sees producer-reported orders, not
 * anything Polaris derived about them. That is the right source here:
 * "how many orders" is a fact the producer reported.
 *
 * It read `event_daily_counts` until 2026-08-17, selecting `profile_id`
 * and filtering on `day`. That projection has neither column: it groups by
 * (project, environment, event, occurred_date) and carries no person at
 * all. The trait had never produced a row, and the `recent_purchasers`
 * audience reading it was empty by construction. Nothing caught it — the
 * SQL is a string, so it type-checks, and the table-name lint passes
 * because the table name was real. `scripts/check-catalog-sql.mjs` now
 * runs every definition against the live schema.
 *
 * And it counted `order.completed` until 2026-08-18, which is not an event
 * this catalog has. The ingester rejects one as `unknown_event`, so the
 * count was over a name nothing could ever emit and the trait STILL
 * produced no rows — the same symptom as the projection bug, one layer
 * out, surviving the fix aimed at it because that fix checked the table.
 *
 * `payment.approved` is the revenue event here, deliberately and only:
 * it is what every destination mapper already reads as its purchase
 * primitive (Meta `Purchase`, GA4 `purchase`, Braze `purchases`) and it
 * carries `order_id`. Registering an `order.completed` alongside it would
 * have given the platform two events meaning "a purchase happened" and
 * made every consumer choose — the trait was the thing that was wrong,
 * not the catalog.
 *
 * `check-catalog-sql.mjs` now resolves event-name literals against the
 * registered catalog, because EXPLAIN cannot: `'order.completed'` is a
 * string, and a string is valid SQL whatever it says.
 */

import { type TraitDefinition, traitDefinitionSchema } from "./types.js";

export const ordersThirtyDays: TraitDefinition = traitDefinitionSchema.parse({
  key: "orders_30d",
  type: "number",
  description: "Completed orders in the last 30 days",
  windowDays: 30,
  // Rows written before the spine carry no profile and never reach this
  // projection — its materialized view drops them rather than storing an
  // empty key, so there is nothing to filter here.
  sql: `
    SELECT
        profile_id,
        toFloat64(sum(event_count)) AS value
    FROM polaris.profile_event_daily_counts
    WHERE project_id = {project:String}
      AND environment = {environment:String}
      AND event = 'payment.approved'
      AND occurred_date >= today() - 30
    GROUP BY profile_id
    HAVING value > 0
  `,
});
