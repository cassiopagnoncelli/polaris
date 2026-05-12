# P2-003: Ingester Batch Validation and Raw Publish

Status: Backlog

## Goal

Implement the ingestion endpoint: batch validation, per-event results, 15-minute retry-storm dedupe, forbidden-field enforcement, canonical stamping, and publish to `raw.events`.

## Required Reading

- [Event Contract](../../architecture/01-event-contract.md)
- [Event Contract / Schema Evolution](../../architecture/01-event-contract.md)
- [Event Contract / Forbidden-Field Policy](../../architecture/01-event-contract.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)

## Dependencies

- P0-006
- P0-007
- P0-009
- P2-002

## Write Scope

Allowed:

```text
apps/ingester-api/
packages/shared-schemas/
packages/shared-kafka/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
sql/
```

## Implementation Notes

- Validate each event independently.
- Accept valid events and reject invalid events in the same batch.
- Invalid events are not published to `raw.events`.
- Use Redis for short-window `event_id` dedupe with a **15-minute default window**. The window is a retry-storm absorber, not the canonical idempotency layer.
- Project-level overrides (up to 24 hours) are configurable; default stays 15 minutes.
- If Redis is unavailable, the boundary must be explicit and tested. Ingestion continues without dedupe; downstream idempotency remains the canonical layer.
- Enforce the forbidden-field policy from P0-009:
  - Apply the policy *before* any structured log line for the event is emitted.
  - Reject decisions return reason code `forbidden_field_rejected` with the field path (never the value).
  - Redact decisions replace the field value with `"[REDACTED:<reason>]"` and the event continues.
  - Pattern-based redactions emit the metric `polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}` per match. The metric label set must never contain the value of the redacted field.
  - Apply project overrides on top of platform defaults.
- Honor schema evolution:
  - Validate each event against the `schema_version` it declared.
  - If the `schema_version` is unknown for that event name, reject with `unsupported_schema_version`.
  - If the `schema_version` is past `sunset_at`, reject with `schema_version_sunset`.
  - If the `schema_version` is marked `deprecated` but pre-sunset, accept the event and emit a metric `polaris_ingest_deprecated_schema_version_total` labeled with event name and version.
- Do not enrich, attribute, resolve identity, or call vendors.

## Acceptance Criteria

- [ ] Batch endpoint exists.
- [ ] Per-event accepted/rejected response exists.
- [ ] Governed schema validation is enforced.
- [ ] `experimental.*` path follows docs.
- [ ] Valid events are published to `raw.events`.
- [ ] Partition key follows project/environment best-available identity rule.
- [ ] Default ingress dedupe window is 15 minutes; per-project override configurable.
- [ ] Forbidden-field reject and redact decisions are wired to the P0-009 policy.
- [ ] Pattern-based redactions emit `polaris_ingest_redacted_pattern_total` with `reason` and `pattern` labels but never the redacted value.
- [ ] No raw value of a redacted or rejected field appears in any log line or metric label.
- [ ] Reason codes `unsupported_schema_version` and `schema_version_sunset` are produced when applicable.
- [ ] Deprecated-version traffic is observable via a metric.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

