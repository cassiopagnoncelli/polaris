# P2-003: Ingester Batch Validation and Raw Publish

Status: Backlog

## Goal

Implement the ingestion endpoint: batch validation, per-event results, 24-hour idempotency check, canonical stamping, and publish to `raw.events`.

## Required Reading

- [Event Contract](../../architecture/01-event-contract.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Redpanda Topics](../../architecture/03-redpanda-topics.md)

## Dependencies

- P0-006
- P0-007
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
- Use Redis for cheap short-window `event_id` dedupe if available; if not available, make the boundary explicit and tested.
- Do not enrich, attribute, resolve identity, or call vendors.

## Acceptance Criteria

- [ ] Batch endpoint exists.
- [ ] Per-event accepted/rejected response exists.
- [ ] Governed schema validation is enforced.
- [ ] `experimental.*` path follows docs.
- [ ] Valid events are published to `raw.events`.
- [ ] Partition key follows project/environment best-available identity rule.

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

