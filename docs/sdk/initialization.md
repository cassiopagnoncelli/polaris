# Initialization

This page enumerates the configuration options accepted by each SDK and their defaults. Type signatures match the actual exports in `sdks/web/src/types.ts` and `sdks/node/src/types.ts`.

## Web SDK

The Web SDK exposes both an asynchronous and a synchronous constructor:

```ts
import { PolarisWebSdk } from "@polaris/web-sdk";

// Recommended path. Probes IndexedDB asynchronously and resolves with a
// fully-wired SDK using the layered queue.
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
});

// Synchronous fallback. Defaults to the always-available memory queue.
// Use this only when you are injecting your own queue or testing the
// queue layer in isolation.
const sdkSync = new PolarisWebSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
});
```

The recommended path is `PolarisWebSdk.create({...})`. The synchronous constructor exists to support callers that want full control over the queue.

### Options

`WebSdkOptions` (full surface):

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `endpoint` | `string` | — | Polaris ingestion endpoint URL. Required to deliver events. |
| `apiKey` | `string` | — | API key bound to project/environment/source by the control plane. Required to deliver events. |
| `source.id` | `string` | `"web"` | Stable identifier for the producer surface. |
| `source.sdkVersion` | `string` | auto-detected | Override the stamped SDK version. The default reads the package version. |
| `defaultContext` | `Partial<Envelope["context"]>` | `{}` | Merged into every event's `context`. |
| `identity` | `IdentityManagerOptions` | `{}` | Forwarded to the layered identity store. See [Identity](./identity.md). |
| `maxQueueSize` | `number` | `1000` | Maximum queued events. Overflow drops by priority. |
| `startupEagerFlushWindowMs` | `number` | `15000` | Eager-flush window after construction. |
| `startupEagerFlushDebounceMs` | `number` | `100` | Debounce inside the eager window. |
| `steadyFlushIntervalMs` | `number` | `5000` | Steady-mode flush interval. |
| `batchSize` | `number` | `20` | Maximum events per flush request. |
| `retry` | `Partial<RetryPolicy>` | exponential backoff w/ jitter | See [Retries](./retries-and-errors.md). |
| `flushOnPagehide` | `boolean` | `true` | Install pagehide/visibilitychange listener for urgent flush. |
| `diagnostics` | `DiagnosticCallbacks` | `{}` | Optional `onError`, `onDrop`, `onRetry`, `onFlush`, `onDiagnostic`. |
| `queue` | `EventQueue` | layered queue | Inject a custom queue (advanced). |
| `transport` | `Transport` | HTTPS / sendBeacon | Inject a custom transport (advanced). |
| `now` | `() => number` | `Date.now` | Inject a clock for tests. |
| `eventIdGenerator` | `() => string` | UUIDv7 | Inject an ID generator for tests. |
| `window` | `Window` | `globalThis.window` | Inject a window for tests in non-DOM contexts. |
| `document` | `Document` | `globalThis.document` | Inject a document for tests in non-DOM contexts. |

### Default retry policy (Web)

```ts
{
  maxRetries: 3,        // total in-line retries per flush attempt
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2, // exponential doubling
  jitterRatio: 0.2,     // ±20% bidirectional jitter
}
```

### Endpoint and API key resolution

`endpoint` and `apiKey` are both `readonly endpoint?: string` and `readonly apiKey?: string` in the type signature so the SDK can be constructed without them for tests. At runtime, omit them only when you also inject a custom transport — otherwise the SDK accepts events but cannot deliver them, and `flush()` returns `{ delivered: 0, queued: <n>, dropped: 0, mode: "steady" }`.

In production, treat both as required:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: process.env.POLARIS_ENDPOINT!,
  apiKey: process.env.POLARIS_API_KEY!,
  source: { id: "checkout-app" },
});
```

## Node SDK

The Node SDK exposes a single synchronous constructor. There is no async equivalent — the Node SDK does not probe IndexedDB or any other async layer.

```ts
import { PolarisNodeSdk } from "@polaris/node-sdk";

const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
});
```

### Options

`PolarisSdkOptions` (full surface):

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `endpoint` | `string` | — | **Required.** Polaris ingestion endpoint URL. |
| `apiKey` | `string` | — | **Required.** API key bound to project/environment/source. |
| `source.type` | `"backend" \| "frontend" \| "mobile" \| "system"` | — | **Required.** Stamped on every event. |
| `source.id` | `string` | — | **Required.** Stable identifier for the producer. |
| `source.sdkVersion` | `string` | auto-detected | Override the stamped SDK version. |
| `defaultContext` | `Partial<Envelope["context"]>` | `{}` | Merged into every event's `context`. |
| `maxQueueSize` | `number` | `10_000` | Maximum queued events; overflow is rejected (`onDrop` fires). |
| `batchSize` | `number` | `50` | Maximum events per flush request. |
| `flushIntervalMs` | `number` | `5_000` | Steady-state flush interval. Set `0` to disable interval flushes. |
| `requestTimeoutMs` | `number` | `10_000` | Per-attempt HTTP timeout in milliseconds. |
| `retry` | `Partial<RetryPolicy>` | exponential backoff w/ jitter | See [Retries](./retries-and-errors.md). |
| `identity` | `IdentityOverrides` | minted | Persistent `anonymous_id`/`session_id` defaults. |
| `diagnostics` | `DiagnosticCallbacks` | `{}` | Optional `onError`, `onDrop`, `onRetry`, `onFlush`, `onDiagnostic`. |
| `queue` | `QueueAdapter` | bounded memory | Inject a durable adapter. |
| `transport` | `Transport` | HTTPS keep-alive | Inject a custom transport. |
| `autoFlushOnShutdown` | `boolean` | `false` | Register `SIGTERM`/`SIGINT` handlers that call `close()`. Opt-in. |
| `shutdownTimeoutMs` | `number` | `5_000` | Bound on the drain inside `close()`. |

### Default retry policy (Node)

```ts
{
  maxAttempts: 5,       // total attempts per flush (one initial + retries)
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2, // exponential doubling
  jitterRatio: 0.2,     // ±20% bidirectional jitter
}
```

The Node policy uses `maxAttempts` (initial + retries) while the Web policy uses `maxRetries` (retries only) — the two SDKs converge on the same concrete schedule but expose slightly different field names because they evolved separately. Treat the names as fixed in the public types.

### Identity defaults (Node)

The Node SDK mints `anonymous_id` and `session_id` at construction. Override via `options.identity`:

```ts
const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
  identity: {
    anonymous_id: "anon_pre_minted",
    session_id: null,
    customer_id: null,
    device_id: null,
  },
});
```

Per-event overrides go through `TrackOptions.identity`:

```ts
await polaris.track("payment.approved", { amount: 12990 }, {
  identity: { customer_id: "cus_123" },
});
```

The Node SDK does not infer identity. Whatever you pass in is what lands on the event.

## Validation at construction

Both SDKs validate options eagerly and throw on misconfiguration. Examples:

- Web: `batchSize` must be a positive integer.
- Node: `endpoint`, `apiKey`, `source.id`, and `source.type` are required.
- Node: `maxQueueSize`, `batchSize` must be positive integers; `flushIntervalMs`, `requestTimeoutMs`, `shutdownTimeoutMs` must be finite numbers.

These checks fail at construction time, not at first `track()`. Surface the error to your application bootstrap; do not catch and swallow.

## Next

- [API Reference](./api-reference.md)
- [Identity](./identity.md)
- [Queue and Flush](./queue-and-flush.md)
