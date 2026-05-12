# P9-005: TikTok Consumer v1

Status: Backlog

## Goal

Implement the first TikTok destination consumer with code-only mappings and vendor dedupe support.

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
consumers/tiktok/v1/
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

- Use stable Polaris delivery IDs as vendor event IDs where supported.
- Do not place TikTok semantics upstream.
- Use mock transport if live TikTok credentials are unavailable.
- Ship `consumers/tiktok/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). Document the TikTok Events API version targeted, the hashed identifier mapping (email, phone, external_id — TikTok rules mirror Meta closely), and `event_id` dedupe behavior.

## Acceptance Criteria

- [ ] Versioned consumer exists with manifest/changelog.
- [ ] `SPEC.md` filled from the consumer SPEC template documents at least one canonical event end-to-end with TikTok-specific normalization rules.
- [ ] At least one mapping is implemented in code.
- [ ] Vendor dedupe field handling is tested.
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

