# Runbook: Normalising Pre-Fix Derived Event IDs

**Severity:** not an alert. This is a one-time backfill, run deliberately, on
a schedule you choose.

**Applies to:** `polaris.analytics_processed` rows written by
`sessionizer`, `identity-resolver` and `attribution-engine` (v1 and v2)
**before** derived event ids became deterministic.

---

## The problem in one paragraph

`polaris.analytics_processed` is a `ReplacingMergeTree(_version)` ordered by
`(project_id, environment, event, event_id)`. Deduplication is therefore
entirely a function of `event_id`: two rows collapse if and only if their ids
match. Processors now derive that id as a UUIDv5 over
`(processor_name, source_event_id, emission slot)` — see
[`derived-id.ts`](../../libs/pipeline/src/derived-id.ts) — so a
redelivery or a replay of the same source event reproduces the same id and the
engine collapses the duplicate.

Before that fix every processor called `uuidv7()` once per emission attempt.
Under at-least-once delivery — a rewind, a crash before the checkpoint landed,
a redelivery after a handler throw — the same source event produced two rows
with two different random ids, and `ReplacingMergeTree` kept both. Those rows
are still there. They will never collapse, not against each other and not
against re-derived ids, because nothing about them is derivable.

## How to tell a pre-fix row from a post-fix one

The UUID version nibble. It is the 15th character of the canonical text form
(`xxxxxxxx-xxxx-Vxxx-xxxx-xxxxxxxxxxxx`), and it is a reliable discriminator
here because the two id schemes in play are the only two Polaris has ever
used for derived events:

| Nibble | Version | Meaning                                    |
| ------ | ------- | ------------------------------------------ |
| `7`    | UUIDv7  | pre-fix, random per attempt — **suspect**  |
| `5`    | UUIDv5  | post-fix, derived and stable — **correct** |

Count the exposure before doing anything:

```sql
SELECT
    processor_name,
    processor_version,
    substring(event_id, 15, 1) AS uuid_version,
    count()                    AS rows,
    min(occurred_at)           AS first_seen,
    max(occurred_at)           AS last_seen
FROM polaris.analytics_processed
WHERE project_id = {project:String} AND environment = {env:String}
GROUP BY processor_name, processor_version, uuid_version
ORDER BY processor_name, uuid_version;
```

`max(occurred_at)` for the `7` group is your cutover timestamp: the moment the
fixed build reached that environment. Nothing newer than it should be a `7`.
If it is, a stale build is still running — stop and fix that first, because a
backfill under a pre-fix writer just re-creates the mess.

### Estimating the actual duplication

Version-7 rows are *suspect*, not *wrong*: a source event delivered exactly
once produced exactly one correct row, random id and all. Only the
redeliveries are duplicates. Measure them before deciding the fix is worth
running:

```sql
SELECT
    count()                                        AS suspect_rows,
    uniqExact(JSONExtractString(properties, 'source_event_id')) AS distinct_sources,
    count() - uniqExact(JSONExtractString(properties, 'source_event_id')) AS surplus
FROM polaris.analytics_processed
WHERE project_id = {project:String}
  AND environment = {env:String}
  AND substring(event_id, 15, 1) = '7'
  AND event = {event:String};
```

Scope this to one `event` at a time. `source_event_id` identifies the input,
but a single input legitimately produces several outputs — attribution emits
up to three — so `surplus` is only meaningful within one emission slot, which
`event` is a proxy for. A `surplus` near zero means the retry path rarely
fired for that window and you can leave the rows alone.

**`identity.*` events need a different key.** `source_event_id` is a property
of `session.*` and `attribution.*` emissions only; identity events do not
carry one. Substitute `link_id`, which the repository allocates per link and
reuses on a redelivery of the same co-occurrence:

```sql
SELECT
    count()                                              AS suspect_rows,
    uniqExact(JSONExtractString(properties, 'link_id'))  AS distinct_links,
    count() - uniqExact(JSONExtractString(properties, 'link_id')) AS surplus
FROM polaris.analytics_processed
WHERE project_id = {project:String}
  AND environment = {env:String}
  AND substring(event_id, 15, 1) = '7'
  AND event = {event:String};
```

If either query returns `distinct_* = 1` alongside a large `suspect_rows`,
you are almost certainly extracting a key that is not there —
`JSONExtractString` returns `''` for a missing field, and every row then
shares one empty key. Check a single row's `properties` before believing the
number.

## Procedure

Run it per `(project, environment, processor)`, smallest blast radius first.
There is no all-at-once mode on purpose.

### 1. Pick a window inside raw retention

`raw.events` is retained 90 days, and `polaris replay create` rejects anything
older with `replay_window_exceeded`. Pre-fix rows outside that window
**cannot be normalised** — the source events they were derived from are gone.
Say so in the incident notes rather than leaving a half-finished backfill
looking like a completed one; the honest end state is "normalised from
`<date>` forward, older rows carry pre-fix ids".

### 2. Dry-run the replay

```bash
polaris replay create --project checkout --env production --target processor --from 2026-05-01T00:00:00Z --to 2026-05-02T00:00:00Z --mode dry_run --reason "derived-id normalisation"
```

`dry_run` plans and counts; it emits no traffic. Check the planned event count
against the `distinct_sources` figure above — they should be the same order of
magnitude. If the plan is far larger, your window is wider than the pre-fix
period and you are about to reprocess events that are already correct. That is
harmless (the re-derived ids collapse onto themselves) but slow.

### 3. Delete the suspect rows for that exact window

Do this **before** the live replay, not after: the replay writes rows with
derived ids, and a delete issued afterwards keyed on the version nibble would
leave them alone but a delete keyed on anything broader would remove what you
just rebuilt.

```sql
ALTER TABLE polaris.analytics_processed
    DELETE WHERE project_id = {project:String}
      AND environment = {env:String}
      AND processor_name = {processor:String}
      AND substring(event_id, 15, 1) = '7'
      AND occurred_at >= {from:DateTime64(3)}
      AND occurred_at <  {to:DateTime64(3)};
```

This is a mutation, not a query: it rewrites every affected part. Watch it to
completion before step 4 —

```sql
SELECT command, parts_to_do, is_done, latest_fail_reason
FROM system.mutations
WHERE table = 'analytics_processed' AND NOT is_done;
```

— because a replay landing while the mutation is mid-flight can have its fresh
rows swept up by the same mutation.

### 4. Replay live

```bash
polaris replay create --project checkout --env production --target processor --from 2026-05-01T00:00:00Z --to 2026-05-02T00:00:00Z --mode live --reason "derived-id normalisation"
```

The processors re-derive ids from `(processor_name, source_event_id, slot)`, so
the rebuilt rows are stable: running this twice produces the same ids and the
second run collapses into the first. That idempotence is the whole reason the
procedure is safe to retry, and it is also why step 3 is a plain delete rather
than something conditional.

### 5. Verify

Re-run the counting query from the top. For the window you normalised, the
`7` group should be gone and the `5` group should hold roughly
`distinct_sources × slots-per-source` rows. Then confirm the analytical
surfaces agree:

```sql
SELECT count() AS rows, uniqExact(event_id) AS distinct_ids
FROM polaris.analytics_processed FINAL
WHERE project_id = {project:String} AND environment = {env:String}
  AND occurred_at >= {from:DateTime64(3)} AND occurred_at < {to:DateTime64(3)};
```

`rows` and `distinct_ids` must be equal under `FINAL`. If they are not, the
merge has not caught up — that is expected and harmless, since `FINAL` and the
`count(DISTINCT event_id)` query patterns both read through it. See
[ClickHouse query patterns](../architecture/07-clickhouse.md).

## Downstream tables

`analytics_processed` feeds projections through materialized views, and **a MV
fires on INSERT, not on merge or on delete**. Two consequences:

- The step 3 delete does **not** propagate. Projection rows derived from the
  deleted duplicates survive.
- The step 4 replay **does** propagate, re-inserting into the projections.

For a `SummingMergeTree` projection this double-counts the replayed window.
Rebuild the projection for that window rather than trusting it to settle —
[`42_session_daily_metrics_rebuild.sql`](../../db/clickhouse/projections/42_session_daily_metrics_rebuild.sql)
is the worked example of the shape. This is the step most likely to be
forgotten, and its symptom (session metrics quietly inflated for one day, six
weeks ago) is one nobody goes looking for.

## When not to run this

If `surplus` is small relative to the window's volume, leave it. The rows are
a fixed, bounded historical artifact that stops growing the moment the fixed
build ships; a replay is live load against production processors and its own
risk. "Old rows are slightly over-counted, new rows are exact" is a defensible
state, and it is strictly better than a botched backfill.

## Related

- [`derived-id.ts`](../../libs/pipeline/src/derived-id.ts) — the derivation itself
- [`32_analytics_processed.sql`](../../db/clickhouse/32_analytics_processed.sql) — engine, dedup key, and why they are what they are
- [Replay stuck](runbook-replay-stuck.md) — when a replay job will not advance
- [Processor version cutover](processor-version-cutover.md) — the other reason to reprocess a window
