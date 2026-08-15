/**
 * `orders_30d` — completed orders in the last 30 days.
 *
 * The shipped example, and deliberately the simplest useful one: it reads a
 * single projection, aggregates one event name, and its correctness is
 * checkable by hand. A first definition that showed off a window function
 * would teach the wrong lesson about what belongs in a trait.
 *
 * Reads `event_daily_counts`, which is fed from `analytics_raw` by a
 * materialized view — so the trait sees producer-reported orders, not
 * anything Polaris derived about them. That is the right source here:
 * "how many orders" is a fact the producer reported.
 */

import { traitDefinitionSchema, type TraitDefinition } from "./types.js";

export const ordersThirtyDays: TraitDefinition = traitDefinitionSchema.parse({
  key: "orders_30d",
  type: "number",
  description: "Completed orders in the last 30 days",
  windowDays: 30,
  // `profile_id` comes from the projection, which the clickhouse-sink v2
  // began stamping when the spine landed. Rows written before that carry no
  // profile and are excluded by the NOT NULL — they are pre-spine history
  // and no profile could be attributed to them honestly.
  sql: `
    SELECT
        profile_id,
        toFloat64(sum(event_count)) AS value
    FROM polaris.event_daily_counts
    WHERE project_id = {project:String}
      AND environment = {environment:String}
      AND event = 'order.completed'
      AND day >= today() - 30
      AND profile_id IS NOT NULL
    GROUP BY profile_id
    HAVING value > 0
  `,
});
