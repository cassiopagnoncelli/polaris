-- Polaris ClickHouse: MV from the profile-event queue into `profiles`.
--
-- The only sanctioned reader of polaris.profile_events_queue.
--
-- ## It unnests the changed-key map
--
-- One queue row — one `profile.updated` — becomes one output row per
-- changed key, plus one per removed key. That is what lets a table keyed
-- `(profile, trait_key)` absorb a stream that carries only what changed;
-- see 36_profiles.sql for why the table is shaped that way.
--
-- `arrayJoin` over the map's keys is the unnest. A row whose `traits` is
-- empty and whose `removed_keys` is empty produces NOTHING, which is
-- correct: the runner does not emit an update with no changes, and if
-- something else ever does, an empty row in the state table would be worse
-- than no row.
--
-- ## Filtering by event name
--
-- Unlike the other two queue MVs, this one filters: `profile.events` also
-- carries `profile.created` and `identity.merged`, and neither describes a
-- trait change. The sink chooses the QUEUE, but this queue is genuinely
-- multi-event, so the discrimination has to happen somewhere and here is
-- the only place that sees the event name and the properties together.

-- SQL SECURITY NONE: the MV's SELECT is not privilege-checked, matching the
-- other queue MVs. Without it the SELECT runs as the inserting user —
-- `polaris_sink`, which holds INSERT and nothing else.
CREATE MATERIALIZED VIEW IF NOT EXISTS polaris.mv_profile_events_to_profiles
ON CLUSTER '{cluster}'
TO polaris.profiles
DEFINER = CURRENT_USER SQL SECURITY NONE
AS
SELECT
    project_id,
    environment,
    toUUID(profile_id) AS profile_id,
    changed.1          AS trait_key,
    changed.2          AS value,
    changed.3          AS removed,
    toUInt64(JSONExtractUInt(properties, 'traits_version')) AS traits_version,
    occurred_at        AS updated_at
FROM polaris.profile_events_queue
ARRAY JOIN
    arrayConcat(
        -- Set keys: (key, value, removed=0).
        arrayMap(
            k -> (k, JSONExtractRaw(JSONExtractRaw(properties, 'traits'), k), toUInt8(0)),
            JSONExtractKeys(JSONExtractRaw(properties, 'traits'))
        ),
        -- Removed keys: (key, '', removed=1). The empty value is never
        -- read, because every reader filters `removed = 0`.
        arrayMap(
            k -> (k, '', toUInt8(1)),
            JSONExtractArrayRaw(properties, 'removed_keys') != []
                ? JSONExtract(properties, 'removed_keys', 'Array(String)')
                : []
        )
    ) AS changed
WHERE event = 'profile.updated'
  -- Table-qualified. A bare `profile_id` here resolves to the SELECT
  -- list's `toUUID(profile_id) AS profile_id`, so ClickHouse tries to
  -- parse '' as a UUID and refuses to create the view at all
  -- (CANNOT_PARSE_UUID). The guard is on the QUEUE's String column.
  AND profile_events_queue.profile_id != '';
