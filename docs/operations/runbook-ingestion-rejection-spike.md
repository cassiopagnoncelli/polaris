# Ingestion Rejection Spike Runbook

Operators use this runbook when ingest batches are being rejected at a
rate that breaches the v1 default thresholds: schema-shape rejections
above 5% of all batch outcomes over five minutes, or forbidden-field
rejections above 1% over five minutes.

Binding architecture references:

- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md)
- [Event Contract](../architecture/01-event-contract.md)
- [Observability and Operations](../architecture/08-observability-and-operations.md)

The ingester code lives at
[`apps/ingester-api/`](../../apps/ingester-api/). The policy guard
that drives forbidden-field rejections lives in
[`packages/shared-policy/`](../../packages/shared-policy/) and the
catalogue of forbidden patterns at
[`catalog/policy/forbidden-fields.ts`](../../catalog/policy/forbidden-fields.ts).
The Prometheus rules that trigger this runbook live at
[`infra/prometheus/rules/polaris.alerts.yml`](../../infra/prometheus/rules/polaris.alerts.yml).

## Alerts that fire this runbook

| Alert | Severity | Threshold |
|---|---|---|
| `PolarisIngestionSchemaRejectionRate` | page | schema-shape rejection share >5% of batch outcomes over 5 minutes (per `project_id`, `environment`) |
| `PolarisIngestionForbiddenFieldRejectionRate` | page | forbidden-field rejection share >1% of batch outcomes over 5 minutes (per `project_id`, `environment`) |

Both expressions are pre-aggregated by recording rule
`polaris:ingest_*_rejection_ratio:rate5m`.

## Symptoms

- A spike in `polaris_ingest_batch_rejected_total` for one
  `(project_id, environment)` while `polaris_ingest_batch_accepted_total`
  stays flat or drops.
- The per-project schema-validation dashboard
  (Grafana UID `polaris-per-project-schema`) shows a sustained ratio
  above the yellow band (0.005) or red band (0.01).
- SDK retries climb on the producer side; producers see HTTP 422s back
  from the ingest endpoint.

## Probable causes, ranked

1. **A producer rolled out an event with a drifted envelope.** Most
   common. An SDK update or a new web-SDK build emits a field with a
   new type, a missing required field, or a new sub-shape. The
   ingester rejects the batch with `reason="schema_validation_failed"`.
2. **The producer forgot to bump the schema version after a contract
   change.** The new payload validates against the new schema but the
   ingester resolves the registered schema by version, so the old
   schema rejects it. Reason: `reason="schema_validation_failed"` and
   the matching ingester log line carries the registered version.
3. **A producer leaked a forbidden field.** A freshly-deployed
   integration writes a `pii_secret`-shaped value into a property bag.
   Reason: `reason="forbidden_field_present"`. NEVER widen the policy
   on the ingester side; the fix is at the producer.
4. **Schema registry has a registration the producer hasn't picked up
   yet.** Newly-registered schemas with stricter required fields can
   reject envelopes in-flight from clients that cached the previous
   schema. Reason: `reason="schema_validation_failed"`.
5. **A producer is sending the wrong envelope to the wrong topic
   family.** Rare, but happens when a downstream system replays into
   `polaris ingest` instead of the intended internal path. Reason:
   varies; the log line carries the routing key.

## Investigation

### 1. Confirm the breakdown on the schema dashboard

Open Grafana, dashboard UID `polaris-per-project-schema`
([`per-project-schema-validation.json`](../../infra/grafana/dashboards/per-project-schema-validation.json)).
Set the `environment` template variable to the alert's environment.
The bottom-right panel ("Per-project rejections by reason") splits
the count by `reason`; the spiking series identifies the failure
class.

### 2. Spot the offending event shape from logs

Loki query (the structured Pino logs from the ingester carry the
rejection reason and the offending event id):

```logql
{polaris_service="ingester-api"}
  | json
  | level="warn"
  | event=~"ingest\\.batch\\.rejected"
  | project_id="${PROJECT_ID}"
  | environment="${ENVIRONMENT}"
```

The log payload includes `reason`, `schema_id`, `schema_version`, and
the rejection details. The ingester deliberately does not log the raw
event body; cross-reference by `event_id` if you need the payload via
producer-side logs.

### 3. Check the recently-registered schemas

```bash
polaris sources show <source_id>
```

The output renders the source's currently-registered schemas, with
versions, registration timestamps, and the `last_seen_at` of each. A
schema registered in the last hour is the first thing to inspect.

### 4. For forbidden-field rejections, identify the field

The redaction-pattern counter is per
`(project_id, environment, reason, pattern)`:

```
polaris_ingest_redacted_pattern_total{
  project_id="${PROJECT_ID}",
  environment="${ENVIRONMENT}"
}
```

Group by `pattern` in Prometheus / Grafana — the breakdown surfaces
the specific forbidden pattern (e.g. `pii_card`, `pii_secret`). The
catalogue of patterns is committed at
[`catalog/policy/forbidden-fields.ts`](../../catalog/policy/forbidden-fields.ts).

## Mitigations

### Short-term

- **Roll back the producer.** If the spike correlates with a producer
  deploy (cross-reference the producer's deploy timestamps against the
  rejection ramp), the fastest recovery is a producer rollback.
- **Disable the offending source.** When the producer is one
  source_id and the rest are healthy, pause the source via
  `polaris sources` and route the producer through DLQ remediation.
  This isolates the blast radius without changing the ingester.

### Long-term

- **Tighten the schema.** If the producer was sending a field shape
  that should never have been accepted, register a new schema version
  with the stricter type. Producers cut over by re-resolving via the
  manifest.
- **Add a forbidden pattern.** When the spike surfaced a credential
  shape the policy catalogue missed, add the pattern in
  `catalog/policy/forbidden-fields.ts` (security review required).

## Escalation

Escalate to the SDK rotation if:

- the rate stays above the alert threshold for 30 minutes despite
  identifying the producer,
- you suspect more than one producer is implicated,
- the affected project's incident impact justifies an emergency SDK
  patch.

Escalate to the security rotation when forbidden-field rejections
include credential-shaped patterns and the producer is unknown or
unresponsive — leaked credentials require a key-rotation review.

## Cross-references

- [Destination DLQ Triage](destination-dlq-triage.md) — once the
  spike turns into DLQ traffic on a destination, that runbook owns
  the downstream surface.
- [Alerts index](alerts.md) — every alert with its threshold and
  this runbook URL.
- [SLOs](slos.md) — the ingester accept-latency SLOs that an
  ingester-side issue can knock over.
