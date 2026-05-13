# P9-001: Destination Consumer Runtime

Status: Blocked (org usage limit, partial implementation staged in worktree `agent-a7054e36bdb4f718e`)

## Goal

Create shared destination consumer runtime helpers for batching, retries, delivery records, DLQs, rate limits, and replay suppression.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-007
- P1-002
- P6-004
- P9-000

## Write Scope

Allowed:

```text
packages/shared-destinations/
consumers/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
packages/shared-destination-normalize/
```

## Implementation Notes

- Keep the runtime thin.
- Implement the three-stage model from [Destinations](../../architecture/06-destinations.md): normalize, map, deliver.
- The runtime owns delivery (auth wrapper, batching, retries, rate limits, DLQs, delivery records, replay suppression).
- The runtime exposes interfaces for normalize and map; each consumer implements those interfaces.
- Normalization composes from `packages/shared-destination-normalize/` (P9-000), with consumer-specific additions in `consumers/<name>/v1/normalize/`.
- Mapper interface: pure function from normalized intermediate to vendor payload. Mappers are not allowed to call out to the network or read raw canonical PII.
- Delivery is the only stage that talks to the network.
- Each stage is independently versioned. The runtime carries each stage's version in delivery records and DLQ metadata so a normalize/v1 → normalize/v2 transition is auditable.
- PostgreSQL stores destination instance state and delivery records.
- Destination sends during replay are disabled by default.
- Secrets must never appear in logs, DLQs, or delivery records.
- Every per-vendor consumer that builds on this runtime (P9-002 through P9-006) ships a `SPEC.md` at `consumers/<vendor>/v<N>/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). The runtime exposes a CLI command (`polaris destinations spec <consumer> <version>`) that surfaces each consumer's SPEC for operator inspection.

## Acceptance Criteria

- [ ] Shared destination package exists.
- [ ] Three-stage interface (normalize, map, deliver) is exposed and documented.
- [ ] Delivery record helper exists and records stage versions.
- [ ] Retry/DLQ helper exists and preserves stage version metadata.
- [ ] Replay suppression helper exists.
- [ ] Tests cover idempotent delivery key generation and secret redaction.
- [ ] Tests verify a mapper that attempts to read raw PII is rejected by the type system or runtime check.

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

