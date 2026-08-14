# Runbook: identity merge storm

**Alert:** `PolarisIdentityMergeBreakerTripped` (page)
**Signal:** `polaris_processor_events_skipped_total{processor_name="sync-identity-resolver", reason="merge_suspended"}` above zero
**Dashboard:** Polaris — Spine (`polaris-spine`), "Safeguards and degradations"

---

## What is happening

The identity stage is **refusing merges**. A profile has absorbed more
merges inside its policy window (default 50 per hour) than the
merge-rate breaker allows, so further merges onto it are declined and
each refusal emits an `identity.merge_suspended` event.

The classic cause is one **promiscuous identifier** — a value that many
different people legitimately send:

- a shared kiosk or demo device whose `anonymous_id` never rotates,
- `customer_id: "guest"` or `"0"` or `""` escaping a producer's
  null-handling,
- a bot or synthetic monitor reusing one identifier,
- a support tool logging into customer accounts under one operator id.

Each event carrying that value alongside a real identifier proves, to
the resolver, that the two are one person. Chain that a few thousand
times and every one of those people is the same person.

## Why it pages rather than warns

The breaker has already stopped the graph from growing — that part is
handled. What it cannot do is undo merges already committed. Every
minute it keeps tripping is a minute of events resolving to a profile
that may already be wrong, and every one of those events is being
delivered to destinations under a merged identity.

The damage is bounded by how fast you find the value, not by the
breaker.

## Triage

**1. Find the offending profile.**

```bash
polaris profiles show <profile_id> --project <id> --env <env>
```

A profile at the centre of a storm looks unmistakable: hundreds or
thousands of identifiers, most of them `anonymous_id`, with a
`first_seen_at` spread across the whole population rather than a
session.

**2. Find the value that joined them.** The suspended-merge events name
the profile; the evidence trail names the identifier:

```bash
polaris profiles links <profile_id> --limit 200
```

Look for one identifier appearing on the left or right of a large
fraction of the pairs. That is the promiscuous value.

In ClickHouse, the same question over a window:

```sql
SELECT
    JSONExtractString(properties, 'identifier') AS identifier,
    count() AS pairs
FROM polaris.analytics_processed
WHERE event = 'identity.linked'
  AND project_id = '<project>'
  AND occurred_at >= now() - INTERVAL 1 DAY
GROUP BY identifier
ORDER BY pairs DESC
LIMIT 20
SETTINGS final = 1
```

## Stop the bleeding

Add the value to the project's denylist in
`catalog/projects/<project_id>.yaml`:

```yaml
identity:
  denylist:
    customer_id:
      - "guest"
    anonymous_id:
      - "<the kiosk device id>"
```

Then restart the identity stage. The policy is deploy-time and
file-backed on purpose — it is a semantic parameter, so it is
recoverable from a git sha and cannot be changed from a web form while
nobody is looking.

Denylisted values resolve **as if absent**: events carrying them still
flow, still bind their other identifiers, and are never dropped. The
refusal is recorded as `identity.link_rejected`.

## Repair

**There is no un-merge.** Merges are derived state, so repair is a
rebuild of the affected profiles from `raw.events` under the corrected
denylist — not an inverse operation:

```bash
polaris profiles rebuild --project <id> --env <env>   # lands with R4
```

Until that verb exists, a merge storm is contained by the denylist and
the affected profiles stay merged. Record the incident and the affected
`profile_id` range; the rebuild is replayable after the fact because
`raw.events` retains 90 days and the archive (R10) extends that.

The losing profiles are tombstoned rather than deleted, so
`profile_id`s already stamped into ClickHouse stay explainable —
`polaris profiles show <loser_id>` will say what absorbed it.

## Prevent

- **Bound the value space at the producer.** A `customer_id` of `"guest"`
  is a producer bug; the denylist is a backstop, not a fix.
- **Narrow the breaker for high-risk projects** via `identity:` in the
  project catalog. A project with a kiosk fleet wants a lower
  `max_merges_per_window`, which trips sooner and merges less before
  anyone notices.
- **Watch the resolution mix**, not just throughput. On the Spine
  dashboard, `merged` should be a small and stable fraction of
  `created` + `bound`. A rising merge share with flat traffic is a storm
  building before the breaker trips.

## Related

- `docs/implementation/pipeline-redesign-plan.md` §4.2 — the safeguard
  set and why all three ship together
- `sync/identity/resolver/v1/processor.manifest.yaml` — the semantic
  parameters and their bounds
- `docs/operations/runbook-processor-lag.md` — if the stage is also
  falling behind
