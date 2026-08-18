# Runbook: verifying spine delivery in ClickHouse

Answering "did this event reach the warehouse, and is the row right?"

This was `runbook-spine-dual-run-parity.md`, which existed to compare
`resolved.events` against the legacy `analytics.events` feed for a week
before retiring it. 126EPNIQ retired that feed outright — the app was
pre-production, so there was no traffic to protect and no parity window to
serve. What survives is everything that was never really about the
comparison: where to look when a row is missing, how the collapse picks a
winner, and why repairing a warehouse row is not the same as replaying.

The parity query and its exit checklist are gone with their subject.

---

## Rule 1: do not count deliveries in `analytics_raw`

`analytics_raw` is a ReplacingMergeTree and collapses by construction.
Counting rows there tells you the dedupe works, not what arrived.

**Count in `analytics_ingest_log`.** It is append-only, keeps duplicates
on purpose, and stamps `_topic` with the concrete partition stream each
row arrived on — the only column that says which family delivered it.

```sql
SELECT toDate(ingested_at) AS day, _topic, count() AS rows
FROM polaris.analytics_ingest_log
WHERE project_id = {project:String}
GROUP BY day, _topic
ORDER BY day DESC, _topic
```

One caveat from its 30-day TTL: questions about a window older than that
cannot be answered here. Ask them within the month or not at all.

---


## Verifying the collapse itself

That the enriched row wins, for a known event:

```sql
SELECT processor_name, profile_id, traits_version, _version
FROM polaris.analytics_raw
WHERE event_id = '<event_id>'
SETTINGS final = 1
```

`processor_name` should read `sync-enrichment-runtime`, and `profile_id`
should be non-empty — resolving one is the identity stage's whole job, so
an empty value means the event never crossed it.

Note `SETTINGS final = 1`, not the `FINAL` keyword: the keyword is
reserved for the documented escape hatch
(`docs/architecture/07-clickhouse.md` § "Query Patterns").

Before a merge runs, duplicate rows for one `event_id` may still be
present — a redelivery, a rewind, a replay. That is normal.
`SETTINGS final = 1` shows the post-collapse answer without waiting.

---

## Failure modes and what they look like

| Symptom | Likely cause | Where to look |
|---|---|---|
| No `resolved.events` rows at all | The enrichment stage is not running, or the sink is not subscribed | `polaris processors list`; the sink's boot log lists its families |
| Rows arriving but `profile_id` empty | The identity stage resolves nothing — a denylist that is too broad, or a producer that stopped sending identifiers | `identity.link_rejected` counts on `identity.events` |
| Rows in the ingest log, nothing in `analytics_raw` | An MV on that table is throwing, which fails the whole INSERT | `polaris_clickhouse_sink_insert_failures_total{table}`; the sink log carries the ClickHouse exception |
| Ingest log lagging the producer | The spine is lagging, not dropping | Consumer lag on `identified.events` / `resolved.events`; `runbook-processor-lag.md` |
| Counts inflated uniformly | Redelivery, not divergence | Checkpoint health; `runbook-clickhouse-ingestion-lag.md` |

---

## Repairing a warehouse row

Worth knowing before you reach for a replay, because the obvious move is
the wrong one.

Replay repairs the **stream**: destinations consume the corrected event
as the next delivery, and that is the end of it. It does not reliably
repair `analytics_raw`. The sink derives `_version` from
`(stage, ingested_at)`, both of which the spine preserves verbatim — so a
repair replay produces the same `event_id` and the same `_version` with
different content, and ReplacingMergeTree breaks a version tie
arbitrarily. The corrected row may or may not win.

That purity is deliberate: it is what makes an ordinary redelivery
collapse onto the original row instead of ratcheting the version forward
on every retry. The warehouse repair is explicit instead:

1. Establish the affected range (`occurred_at` partitions —
   `analytics_raw` is `PARTITION BY toYYYYMM(occurred_at)`).
2. Drop those partitions, or delete the affected `event_id` set.
3. Replay the range through the spine.

Deleting first makes the replayed rows the only rows, so no tie-break
happens. This mirrors what `polaris clickhouse-rebuild` already does for
projections — see `docs/development/clickhouse-rebuilds.md`.

**Rule of thumb:** replaying to fix a destination needs no delete;
replaying to fix a number on a dashboard does.
