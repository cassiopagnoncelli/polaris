# P3-001: Node SDK Core

Status: Backlog

## Goal

Implement the initial Node SDK with queue-first transport, core API, batching, retry, and explicit shutdown lifecycle.

## Required Reading

- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-006

## Write Scope

Allowed:

```text
packages/node-sdk/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
packages/web-sdk/
apps/
processors/
consumers/
```

## Implementation Notes

- Core API: `track`, `identify`, `reset`, `flush`, `close`.
- Queue-first means enqueue before attempting send.
- Default queue is bounded in-memory.
- Preserve event IDs across retries.
- Provide queue adapter interface.
- Do not register process signal handlers by default.

## Acceptance Criteria

- [ ] Node SDK package exists.
- [ ] Core API exists.
- [ ] Memory queue exists.
- [ ] Retry preserves `event_id`.
- [ ] `flush()` and `close()` exist.
- [ ] Tests cover queue-first behavior.

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

