# P3-002: Web SDK Identity Persistence

Status: Backlog

## Goal

Implement Web SDK identity lifecycle and layered browser persistence.

## Required Reading

- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P0-006

## Write Scope

Allowed:

```text
packages/web-sdk/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
packages/node-sdk/
apps/
processors/
consumers/
```

## Implementation Notes

- Implement `anonymous_id`, `session_id`, and `customer_id` lifecycle.
- Persistence layers: first-party cookie, localStorage mirror, sessionStorage fallback, memory fallback.
- No third-party cookies.
- No fingerprinting.
- `reset()` rotates anonymous identity by default.
- `reset({ anonymous: false })` keeps anonymous identity.
- 30-minute inactivity sessions.
- Do not rotate sessions on campaign changes.

## Acceptance Criteria

- [ ] Identity state initializes before first `track()`.
- [ ] Capability detection exists.
- [ ] Storage fallback is tested.
- [ ] `identify()` creates future identity overlap.
- [ ] `reset()` behavior matches docs.
- [ ] Session timeout behavior is tested.

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

