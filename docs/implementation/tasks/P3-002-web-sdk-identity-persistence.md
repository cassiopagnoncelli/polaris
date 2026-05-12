# P3-002: Web SDK Identity Persistence

Status: Ready

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
  packages/web-sdk/package.json                              new
  packages/web-sdk/tsconfig.json                             new
  packages/web-sdk/vitest.config.ts                          new (happy-dom env)
  packages/web-sdk/src/index.ts                              new
  packages/web-sdk/src/types.ts                              new
  packages/web-sdk/src/sdk.ts                                new (public-surface stub)
  packages/web-sdk/src/internal/ids.ts                       new
  packages/web-sdk/src/internal/environment.ts               new (capability probes + WebView heuristic)
  packages/web-sdk/src/identity/index.ts                     new
  packages/web-sdk/src/identity/serialize.ts                 new
  packages/web-sdk/src/identity/cookie-store.ts              new (CookieStore)
  packages/web-sdk/src/identity/web-storage-store.ts         new (LocalStorageStore, SessionStorageStore)
  packages/web-sdk/src/identity/memory-store.ts              new (MemoryStore)
  packages/web-sdk/src/identity/layered-store.ts             new (LayeredIdentityStore)
  packages/web-sdk/src/identity/manager.ts                   new (IdentityManager + session rotation + reset)
  packages/web-sdk/test/helpers/dom.ts                       new (cookie-cleanup helper)
  packages/web-sdk/test/cookie-store.test.ts                 new (14 tests)
  packages/web-sdk/test/web-storage-store.test.ts            new (9 tests)
  packages/web-sdk/test/memory-store.test.ts                 new (3 tests)
  packages/web-sdk/test/layered-store.test.ts                new (9 tests)
  packages/web-sdk/test/identity-manager.test.ts             new (28 tests)
  packages/web-sdk/test/sdk.test.ts                          new (6 tests)
  pnpm-lock.yaml                                             regenerated for happy-dom

Commands run:
  pnpm install
  pnpm --filter @polaris/web-sdk typecheck
  pnpm --filter @polaris/web-sdk lint
  pnpm --filter @polaris/web-sdk test
  pnpm --filter @polaris/web-sdk build
  pnpm typecheck      (workspace)
  pnpm lint           (workspace)
  pnpm format:check   (workspace)
  pnpm test           (workspace — 606 tests, all green)

Checks passed:
  - typecheck (workspace + web-sdk)
  - biome lint (no warnings)
  - biome format check
  - vitest (69 tests in web-sdk, 606 across workspace, all green)
  - tsc build emits dist/ with .d.ts and source maps

Known gaps:
  - The queue (IndexedDB + localStorage + memory), HTTPS transport,
    batch flush, retry, eager-flush mode, and `track()` semantics are
    deliberately out of scope. They land in P3-003.
  - `PolarisWebSdk.track()` and `PolarisWebSdk.flush()` are
    placeholders that reject with a descriptive error referring to
    P3-003. Identity surface (`identify`, `reset`, capability,
    diagnostics, envelope identity) is fully wired.
  - No browser bundle (IIFE/UMD) yet — `tsc` emits ESM only. The
    script-tag loader + bundle is later work per the SDK Standards
    doc.
```

