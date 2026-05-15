# DLQ Growth Runbook

Operators use this runbook when a processor or destination is moving
messages to the dead-letter queue at a rate that breaches the v1
default thresholds:

- processor DLQ growth above 100/min (warn) or 1000/min (page)
- destination DLQ growth above 50/min (page)

Binding architecture references:

- [Processors and Replay](../architecture/05-processors-and-replay.md)
- [Destinations](../architecture/06-destinations.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The shared processor runtime emitting the DLQ counter lives at
[`packages/shared-processor/`](../../packages/shared-processor/); the
destination runtime equivalent lives at
[`packages/shared-destinations/`](../../packages/shared-destinations/).
The destination DLQ schema and CLI surface are documented in
[`destination-dlq-triage.md`](destination-dlq-triage.md); this
runbook does NOT duplicate it — for destination-side DLQ details,
cross-link out. The Prometheus rules that trigger this runbook live
at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisProcessorDLQGrowthWarn` | warn | `polaris_processor_events_dlq_total` rate > 100/min for 5m, per `(processor_name, processor_version, project_id, environment)` |
| `PolarisProcessorDLQGrowthPage` | page | `polaris_processor_events_dlq_total` rate > 1000/min for 5m |
| `PolarisDestinationDLQGrowth` | page | `polaris_destination_events_dlq_total` rate > 50/min for 5m, per destination instance |

Recording rules `polaris:processor_dlq_growth:rate1m` and
`polaris:destination_dlq_growth:rate1m` pre-aggregate the per-minute
rates.

## Symptoms

- One of the DLQ growth alerts fires.
- For destination DLQs: rows accumulate in
  `dlq_records` for one vendor or one destination instance; surface
  via `polaris dlq list`.
- For processor DLQs: the processor's emit rate
  (`polaris_processor_events_emitted_total`) drops while
  `polaris_processor_events_consumed_total` stays flat — events are
  going to DLQ instead of being emitted.

## Probable causes, ranked

### Processor DLQ

1. **Bad event payload.** A producer rolled out events the processor's
   handler can't process (mapping miss, missing required field). Drains
   to the processor's DLQ topic via the runtime's standard fail/retry
   ladder.
2. **External dependency permanently unavailable.** A required external
   service is down (identity-resolver depends on a lookup table, the
   geoip enricher depends on its data file). Messages exhaust the retry
   budget and DLQ.
3. **Processor regression.** A processor deploy introduced a bug; old
   events that previously processed cleanly now DLQ.
4. **Replay misconfigured.** A `polaris replay create` issued against
   the wrong window or wrong target pushes events the processor can't
   handle.

### Destination DLQ

See [`destination-dlq-triage.md`](destination-dlq-triage.md) for the
canonical destination-side root-cause taxonomy
(`error_class={auth,mapping,permanent,rate_limit,...}`). The top
causes in summary:

1. Vendor returned 4xx (auth, mapping, permanent).
2. Vendor returned 429 / rate limit, retries exhausted.
3. Mapper version mismatch.
4. Canonical envelope drifted from the mapper's expectations.

## Investigation

### 1. Identify the failing surface

For processor DLQ:

```
sum by (processor_name, project_id) (
  polaris:processor_dlq_growth:rate1m
)
```

The pivot with the highest rate is the affected processor. Match it
to a recent deploy by reading the processor's deploy log.

For destination DLQ:

```bash
polaris dlq list --vendor <vendor> --limit 50
```

or scoped to one destination:

```bash
polaris dlq list --destination <destination_id> --since <iso8601>
```

Output table shows `published_at`, `dlq_id`, `attempts`, `reason`,
`error_class`, and the originating event id. Cluster the output by
`error_class` — most spikes hit one class.

### 2. Inspect a representative row

For destination DLQ:

```bash
polaris dlq show <dlq_id>
```

For processor DLQ, locate the DLQ topic for the processor (per the
processor's README) and inspect with `rpk topic consume` or the
Redpanda console.

### 3. Cross-reference processor logs

```logql
{polaris_service="${PROCESSOR_NAME}"}
  | json
  | event="processor.message.dlq"
  | environment="${ENVIRONMENT}"
```

Each DLQ event log line carries `event_id`, `project_id`, `reason`,
the handler's terminal error message, and the retry count. The
`reason` clusters the failure mode.

### 4. Confirm whether the spike is a producer-side regression

If the producer rolled out a new SDK / web SDK version close to the
spike's start, suspect cause #1 (bad payload). Compare:

```
sum by (project_id, environment, schema_version) (
  rate(polaris_ingest_batch_accepted_total[5m])
)
```

against `polaris_processor_events_dlq_total` rate. A new schema
version with a sharp ramp aligns DLQ growth to the new payload shape.

## Mitigations

### Short-term

- **For destination DLQ:** triage per
  [`destination-dlq-triage.md`](destination-dlq-triage.md). Mark
  resolved or retry as appropriate.
- **For processor DLQ:** if a poison message is dominant, the
  processor's DLQ topic can be drained for forensic review (do NOT
  blindly re-feed). If a producer is at fault, roll the producer back
  or pause the source via `polaris sources`.
- **Disable a misbehaving destination:**
  ```bash
  polaris destinations disable <destination_id> --reason "DLQ spike during investigation"
  ```
  This stops the consumer from publishing further attempts while you
  triage. Audited per P6-007.

### Long-term

- **Fix the producer or the schema.** If the spike traces to a
  producer-side regression, the long-term fix is the producer.
- **Bump the consumer / mapper version.** When the destination's
  vendor contract changed, register a new consumer version with the
  updated mapper.
- **Add a guard at ingest.** If the bad payload should have been
  caught earlier, tighten the registered schema so the rejection
  happens at ingest, not at processor / destination.

## Escalation

Page the on-call data engineer if:

- the DLQ rate stays above the page threshold for 30 minutes
  without an identified producer,
- destination DLQ for one vendor exceeds 10 minutes of sustained
  alert and the vendor's status page is green (i.e. it's our
  problem, not theirs),
- processor DLQ for `identity-resolver` exceeds the page threshold
  (identity DLQ correctness has downstream attribution implications).

Page the security rotation if a destination DLQ spike correlates
with `error_class='auth'` for multiple destinations (suggests a
shared credential / secret-provider issue, see
[`destination-dlq-triage.md`](destination-dlq-triage.md)).

## Cross-references

- [Destination DLQ Triage Runbook](destination-dlq-triage.md) — the
  destination-side detailed surface; this runbook is the alert entry
  point, that runbook is the deep triage workflow.
- [Destination API Failure Runbook](runbook-destination-api-failure.md) —
  the upstream failure mode that turns into DLQ growth.
- [Ingestion Rejection Spike Runbook](runbook-ingestion-rejection-spike.md) —
  when the bad payload should have been rejected at ingest.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
