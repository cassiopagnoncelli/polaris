# P3-003: Web SDK Queue and Transport

Status: Done (merged in `889bb9f`)

## Goal

Implement Web SDK offline-first lifecycle-aware queueing, transport, retry, priority overflow, diagnostics, and script loader.

## Required Reading

- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P3-002

## Write Scope

Allowed:

```text
packages/web-sdk/
```

Forbidden:

```text
packages/node-sdk/
apps/
processors/
consumers/
```

## Implementation Notes

- Queue-first: enqueue before network delivery.
- Queue storage: IndexedDB, localStorage, memory.
- IndexedDB is preferred but not guaranteed; use real capability checks.
- First 15 seconds use eager flush.
- Steady flush interval defaults to 5 seconds.
- Use `sendBeacon` or `fetch` keepalive on page-exit where appropriate.
- Queue priority default is `normal`.
- Overflow drops oldest low, then normal, then high.
- WebView delivery remains best-effort.

## Acceptance Criteria

- [ ] Queue-first behavior exists.
- [ ] IndexedDB/localStorage/memory fallbacks exist.
- [ ] Eager flush and steady flush modes exist.
- [ ] Retry preserves `event_id`.
- [ ] Priority overflow policy is tested.
- [ ] Diagnostic callbacks exist.
- [ ] Script loader with pre-init queue exists or is stubbed with tests.

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

