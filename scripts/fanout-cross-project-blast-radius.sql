-- Blast radius of adding a project filter to destination fan-out.
--
-- WHY THIS EXISTS
--   `packages/shared-destinations/src/runtime.ts` resolves fan-out targets by
--   (vendor, environment) only — `project_id` rides the envelope and is
--   stamped onto metrics and delivery records, but is NOT a routing key. So an
--   event from project A is already delivered to project B's destination row
--   of the same vendor in the same environment.
--
--   Card C8 adds the missing `project_id` filter. That is a correctness fix,
--   but it is also the one change in the project-config programme that STOPS
--   deliveries someone may be depending on. This query is the review gate:
--   every row it returns is a delivery path that will go silent.
--
-- WHERE TO RUN IT
--   Against PRODUCTION, then staging. A local database has no delivery history
--   and will return zero rows regardless of the real answer — running it
--   locally proves nothing.
--
-- HOW TO READ THE RESULT
--   No rows      → the filter is a no-op in practice. Land C8 freely.
--   Rows         → each is (destination instance) × (foreign project whose
--                  events it currently receives). Decide per row whether that
--                  traffic is load-bearing before landing C8. A row with a
--                  recent `last_seen` and a high `deliveries` is someone's
--                  live pipeline.
--
-- @see docs/implementation/project-config-plan.md §8

SELECT
  d.destination_id,
  d.vendor,
  d.instance_label,
  d.environment,
  d.project_id                      AS destination_owner_project,
  dr.project_id                      AS event_source_project,
  d.status,
  count(*)                           AS deliveries,
  min(dr.started_at)                 AS first_seen,
  max(dr.started_at)                 AS last_seen,
  count(*) FILTER (WHERE dr.status = 'delivered') AS delivered_ok
FROM delivery_records dr
JOIN destinations d
  ON d.destination_id = dr.destination_id
WHERE dr.project_id IS DISTINCT FROM d.project_id
GROUP BY
  d.destination_id, d.vendor, d.instance_label, d.environment,
  d.project_id, dr.project_id, d.status
ORDER BY last_seen DESC, deliveries DESC;
