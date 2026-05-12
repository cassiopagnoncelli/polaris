# P9-006: Braze Consumer v1

Status: Backlog

## Goal

Implement the first Braze destination consumer with stronger reliance on Polaris delivery records because vendor event dedupe may be weak.

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
consumers/braze/v1/
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

- Assume weak or no generic vendor event dedupe.
- Enforce Polaris delivery idempotency before sending.
- Mapping semantics remain code-only.
- Use mock transport if live Braze credentials are unavailable.
- Ship `consumers/braze/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). The SPEC must include an explicit "Known divergences from canonical" entry noting that vendor dedupe is weak and that Polaris-side delivery-key idempotency is the canonical guard against double-delivery.

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
- [ ] `SPEC.md` filled from the consumer SPEC template documents the Braze mapping, the dedupe-weakness divergence, and the Polaris-side idempotency contract.
- [ ] At least one mapping is implemented in code.
- [ ] Polaris delivery idempotency is tested.
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

