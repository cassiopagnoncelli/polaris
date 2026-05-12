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

- Use stable Polaris delivery IDs as vendor dedupe IDs where supported.
- Do not place Meta semantics upstream.
- Do not store access tokens in PostgreSQL.
- If live Meta API access is unavailable, implement against an interface and test with a mock transport.

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
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

