# P9-003: Meta CAPI Consumer v1

Status: Backlog

## Goal

Implement the first Meta CAPI destination consumer with code-only mappings and vendor dedupe support.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P0-008
- P6-004

## Write Scope

Allowed:

```text
consumers/meta-capi/v1/
packages/shared-destinations/
docs/destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
db schema changes not needed for this consumer
```

## Implementation Notes

- Use stable Polaris delivery IDs as vendor dedupe IDs where supported (Meta accepts `event_id` for cross-channel dedupe).
- Do not place Meta semantics upstream.
- Do not store access tokens in PostgreSQL.
- If live Meta API access is unavailable, implement against an interface and test with a mock transport.
- Ship `consumers/meta-capi/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). The SPEC documents field mapping per canonical event, normalization rules (Meta requires sha256(lowercase(trim(email))) for `em`, similar for `ph`, `external_id`), error class table, rate-limit profile, and the Meta API version the consumer targets.
- Normalization composes from `packages/shared-destination-normalize/`; Meta-specific rules (action_source inference, fbp/fbc cookie passthrough) live in `consumers/meta-capi/v1/normalize/`.

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
- [ ] `SPEC.md` filled from the consumer SPEC template documents at least one canonical event end-to-end (mapping table, normalization, dedupe, error classes, fixtures).
- [ ] At least one mapping is implemented in code.
- [ ] Vendor dedupe field handling is tested.
- [ ] Delivery records are written.
- [ ] Replay suppression is honored.
- [ ] Mock transport tests cover success and failure cases.

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

