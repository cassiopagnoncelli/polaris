# P7-004: Destination Replay Guardrails

Status: Ready

## Goal

Implement destination replay suppression and explicit opt-in behavior.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Destinations](../../architecture/06-destinations.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P7-001
- P9-001

## Write Scope

Allowed:

```text
packages/shared-replay/
consumers/
apps/polaris-cli/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
```

## Implementation Notes

- Destination sends during replay are disabled by default.
- Explicit opt-in must be visible in replay job state.
- Consumers must check replay delivery policy before sending.
- Suppressed sends should produce auditable records, not silent drops.

## Acceptance Criteria

- [ ] Replay jobs default destination delivery to disabled.
- [ ] CLI requires explicit flag/reason to enable destination sends.
- [ ] Destination consumer runtime honors suppression.
- [ ] Suppressed delivery attempts are recorded.
- [ ] Tests cover default suppression and explicit opt-in.

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

