# Runbook: spine dual-run parity (M3)

Verifying that `resolved.events` carries the same facts as the legacy
`analytics.events` feed, before anything is retired.

**Milestone:** M3 of `docs/implementation/pipeline-redesign-plan.md` §7.
**Exit condition:** parity holds for a full week at production volume,
after which R2C retires the legacy projector.

---

## What "dual-run" means here

Two feeds carry the same customer events into ClickHouse at once:

| Feed | Producer | Carries `profile` | `_version` rank |
|---|---|---|---|
| `analytics.events` | `analytics-projector` v1 (legacy) | no | 0 |
| `resolved.events` | the spine (identity → enrichment) | yes | 1 |

They deliberately share `event_id`, because they are **two sightings of
one fact, not two facts**. That is what makes them comparable — and it is
also why they collapse into each other in `analytics_raw`, whose sort key
is `(project_id, environment, event, event_id)`.

The `_version` rank decides which survives. The resolved row wins every
time, so `analytics_raw` converges on the enriched copy. See
`sql/clickhouse/30_analytics_raw.sql` and
`packages/shared-clickhouse/src/version.ts`.

---

## Rule 1: do not measure parity in `analytics_raw`

`analytics_raw` collapses the two feeds by construction. Counting rows
there tells you the dedupe works, not whether both feeds delivered.

**Measure in `analytics_ingest_log`.** It is append-only, keeps
duplicates on purpose, and stamps `_topic` with the concrete partition
stream a row arrived on — which is the only column that distinguishes
the feeds after the fact.

One caveat that follows from its 30-day TTL: parity questions about a
window older than that cannot be answered here. Ask them within the
month or not at all.

---

## The parity query

Per event and day, how many rows each feed delivered:

```sql
SELECT
    toDate(ingested_at)                                   AS day,
    project_id,
    event,
    countIf(_topic LIKE 'analytics.events%')              AS legacy_rows,
    countIf(_topic LIKE 'resolved.events%')               AS resolved_rows,
    uniqExact(event_id)                                   AS distinct_events,
    countIf(_topic LIKE 'resolved.events%' AND profile != '') AS with_profile
FROM polaris.analytics_ingest_log
WHERE ingested_at >= now() - INTERVAL 1 DAY
GROUP BY day, project_id, event
ORDER BY day DESC, project_id, event
```

Read it like this:

- **`legacy_rows` ≈ `resolved_rows`.** Exact equality is not the target —
  both feeds are at-least-once, so redelivery inflates either side
  independently. A stable ratio near 1.0 is the signal; a persistent gap
  in one direction is not.
- **`distinct_events` ≈ `legacy_rows`.** If distinct events are markedly
  fewer, one feed is redelivering heavily. Check consumer lag before
  concluding anything about parity.
- **`with_profile` ≈ `resolved_rows`.** Events the identity stage could
  not resolve to a person legitimately carry no profile, so a small
  shortfall is normal — server-side events with neither `customer_id` nor
  `anonymous_id`. A large one means the identity stage is failing to
  resolve, not that the sink is failing to carry.

### Events on one feed only

The query that finds actual divergence:

```sql
SELECT
    event_id,
    event,
    project_id,
    groupUniqArray(splitByChar('-', _topic)[1]) AS feeds
FROM polaris.analytics_ingest_log
WHERE ingested_at >= now() - INTERVAL 1 DAY
  AND (_topic LIKE 'analytics.events%' OR _topic LIKE 'resolved.events%')
GROUP BY event_id, event, project_id
HAVING length(feeds) = 1
LIMIT 100
```

Every row is an event one feed saw and the other did not. Some asymmetry
is expected at the window edges — an event ingested just before the
window opens reaches the two feeds at slightly different times, because
the spine is two hops further downstream. Filter to the window's interior
before investigating:

```sql
  AND ingested_at BETWEEN now() - INTERVAL 1 DAY + INTERVAL 10 MINUTE
                      AND now() - INTERVAL 10 MINUTE
```

---

## Verifying the collapse itself

That the enriched row wins, for a known event:

```sql
SELECT processor_name, profile_id, traits_version, _version
FROM polaris.analytics_raw
WHERE event_id = '<event_id>'
SETTINGS final = 1
```

`processor_name` should read `sync-enrichment-runtime`. If it reads
`analytics-projector`, the resolved row either never arrived (check the
ingest log for that `event_id`) or arrived with rank 0 — which would mean
the sink routed it as legacy, i.e. `versionStageFor` did not recognise
the family.

Note `SETTINGS final = 1`, not the `FINAL` keyword: the keyword is
reserved for the documented escape hatch
(`docs/architecture/07-clickhouse.md` § "Query Patterns").

Before a merge runs, both rows are still present — that is normal, not a
parity failure. `SETTINGS final = 1` shows the post-collapse answer
without waiting for the merge.

---

## Failure modes and what they look like

| Symptom | Likely cause | Where to look |
|---|---|---|
| `resolved_rows` is 0 | The enrichment stage is not running, or the sink is not subscribed | `polaris processors list`; the sink's boot log lists its families |
| `resolved_rows` climbing but `with_profile` near 0 | The identity stage resolves nothing — a denylist that is too broad, or a producer that stopped sending identifiers | `identity.link_rejected` counts on `identity.events` |
| Both feeds present, `analytics_raw` shows the legacy row | Rank not applied: the sink treated `resolved.events` as legacy | `_version` in the ingest log for that `event_id` — a resolved row should be far above 1e14 |
| `legacy_rows` far exceeds `resolved_rows` | The spine is lagging, not dropping | Consumer lag on `identified.events` / `resolved.events`; `runbook-processor-lag.md` |
| Both counts inflated equally | Redelivery, not divergence | Checkpoint health; `runbook-clickhouse-ingestion-lag.md` |

---

## Exit checklist for R2C (retiring the legacy feed)

- [ ] Parity holds for seven consecutive days at production volume.
- [ ] `with_profile / resolved_rows` is stable, and the shortfall is
      explained by genuinely unidentifiable events rather than by
      resolution failures.
- [ ] No single-feed events in the window interior, or each remaining
      case is understood and written down.
- [ ] Dashboards and saved queries that read `processor_name =
      'analytics-projector'` have been repointed — retiring the feed
      changes what that column says, and a query filtering on it will
      silently return nothing rather than erroring.

Only then does R2C (`126EPNIQ`) retire the projector.
