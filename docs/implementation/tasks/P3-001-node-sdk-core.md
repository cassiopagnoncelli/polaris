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
  packages/node-sdk/package.json                        new (workspace dep on @polaris/shared-schemas, uuid@^14)
  packages/node-sdk/tsconfig.json                       new (extends ../../tsconfig.base.json)
  packages/node-sdk/vitest.config.ts                    new
  packages/node-sdk/src/index.ts                        new (public surface re-exports)
  packages/node-sdk/src/types.ts                        new (PolarisSdkOptions, QueueAdapter, Transport, diagnostics)
  packages/node-sdk/src/sdk.ts                          new (PolarisNodeSdk class: track/identify/reset/flush/close)
  packages/node-sdk/src/internal/ids.ts                 new (UUIDv7 event_id and identity helpers via uuid@^14 v7)
  packages/node-sdk/src/internal/retry.ts               new (exponential backoff + jitter, unref'd sleep)
  packages/node-sdk/src/internal/validation.ts          new (basic envelope/client-side validation only)
  packages/node-sdk/src/queue/index.ts                  new
  packages/node-sdk/src/queue/memory.ts                 new (bounded MemoryQueueAdapter)
  packages/node-sdk/src/transport/index.ts              new
  packages/node-sdk/src/transport/https.ts              new (HTTPS POST with keep-alive Agent, parses per-event batch result)
  packages/node-sdk/test/sdk.test.ts                    new (25 SDK behaviour tests incl. queue-first + retry preserves event_id)
  packages/node-sdk/test/memory-queue.test.ts           new (6 tests)
  packages/node-sdk/test/retry.test.ts                  new (5 tests)
  packages/node-sdk/test/validation.test.ts             new (18 tests)
  packages/node-sdk/test/https-transport.test.ts        new (9 tests against a real local HTTP server)

Commands run:
  pnpm install
  pnpm --filter @polaris/shared-schemas build
  pnpm --filter @polaris/node-sdk typecheck
  pnpm --filter @polaris/node-sdk build
  pnpm --filter @polaris/node-sdk test
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm build

Checks passed:
  typecheck — workspace + @polaris/node-sdk
  lint — biome lint . (176 files)
  format:check — biome format . (176 files)
  test — 500 tests (63 node-sdk) across 42 files
  build — @polaris/node-sdk emits dist/ ESM + .d.ts

Known gaps:
  - Default queue is bounded in-memory and does NOT survive process crashes
    (documented in src/queue/memory.ts and src/index.ts). Operators needing
    crash-safe queueing implement the QueueAdapter interface; first-party
    Redis/filesystem adapters are explicitly deferred per the task card.
  - identify() does not auto-emit a "user.identified" event. The Node SDK
    is a transport helper, not an analytics engine; callers track() that
    event explicitly if they want it.
  - autoFlushOnShutdown registers SIGTERM/SIGINT handlers when opt-in. No
    handlers are registered by default. Default `false`.
  - The SDK does not bundle the event catalog; only basic envelope/client
    validation (event-name regex, properties shape, occurred_at ISO,
    schema_version positive int). The ingester remains authoritative.
  - source.sdkVersion defaults to "0.0.0" until a release-versioning pass
    wires real package versions through to source.sdk_version.
  - HttpsTransport accepts plain http:// for local dev/test against
    TLS-terminating proxies; production wiring expects https://.
```

