# P9-004: GA4 Consumer v1

Status: Backlog

## Goal

Implement the first GA4 destination consumer with code-only mappings and careful purchase dedupe behavior.

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
consumers/ga4/v1/
packages/shared-destinations/
docs/destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Use stable `transaction_id` for purchase mappings when available.
- Do not promise universal GA4 event dedupe.
- Use mock transport if live GA4 credentials are unavailable.
- Mapping semantics remain code-only.
- Ship `consumers/ga4/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). Document the GA4 Measurement Protocol version targeted, the `client_id`/`user_id` mapping from canonical identity, and the timestamp shape (GA4 uses microseconds since epoch via `timestamp_micros`).

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
- [ ] `SPEC.md` filled from the consumer SPEC template documents the GA4 mapping including purchase dedupe via `transaction_id` and the client/user identity mapping.
- [ ] At least one mapping is implemented in code.
- [ ] Purchase/transaction dedupe behavior is documented and tested.
- [ ] Delivery records are written.
- [ ] Replay suppression is honored.

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

