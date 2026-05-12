# Queue and Flush

This page covers the SDK queueing model and the flush lifecycle.

## Queue layers

### Web SDK

The Web SDK picks the strongest available queue layer at construction time:

```text
IndexedDB preferred    -> large quota, async, structured
localStorage fallback  -> 5-10 MB, sync, string-only
memory fallback        -> transient — events lost on navigation
```

Cookies are **never** used for event queues.

`PolarisWebSdk.create()` probes IndexedDB asynchronously and selects the strongest available layer. The synchronous `new PolarisWebSdk()` defaults to memory; use it only when you are injecting a custom queue.

The selected layer is exposed via diagnostics:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  diagnostics: {
    onDiagnostic: (d) => {
      if (d.kind === "queue_layer_selected") {
        console.log("queue layer:", d.detail?.layer);
      }
    },
  },
});
```

### Node SDK

The Node SDK uses a **bounded in-memory queue** by default. The default queue does **not** survive process crashes.

Critical backend producers should either:

- inject a durable `QueueAdapter` implementation (Redis, filesystem, application outbox table)
- emit events from their own reliable outbox system, calling the SDK only for the wire transport

The Node SDK exposes the `QueueAdapter` interface so durable backends can plug in. Only the interface and the memory adapter ship today; the Redis and filesystem adapters are future work. See [Node Queue Adapter Guidance](#node-queue-adapter-guidance) below.

## Web SDK: flush lifecycle

The Web SDK has three flush phases:

```text
0–15s after SDK init       eager flush mode
after 15s                  steady batch mode
pagehide / manual flush    urgent flush mode
```

### Eager mode

For the first 15 seconds after construction, every `track()` schedules a debounced flush (default 100ms). This catches the short-visit pattern: a user arrives, fires two or three events, then leaves before the steady interval would ever tick.

Defaults:

```text
startup_eager_flush_window_ms: 15000
startup_eager_flush_debounce_ms: 100
```

Tune via:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  startupEagerFlushWindowMs: 15_000,
  startupEagerFlushDebounceMs: 100,
});
```

Set `startupEagerFlushWindowMs: 0` to start in steady mode immediately (rare; mostly useful for tests).

### Steady mode

After the eager window expires, the SDK switches to interval-driven flushes (default every 5 seconds).

```text
steady_flush_interval_ms: 5000
batch_size: 20
```

Steady mode also triggers a flush when the queue size reaches `batchSize`, so a fast burst delivers without waiting on the interval.

Tune via:

```ts
{
  steadyFlushIntervalMs: 5_000,
  batchSize: 20,
}
```

### Urgent mode

The SDK installs a `pagehide` (with `visibilitychange` fallback) listener that triggers an urgent flush on page exit. Urgent flushes:

- drain everything in the queue, not just `batchSize`
- prefer `navigator.sendBeacon` (queued by the browser before the tab dies)
- fall back to `fetch(..., { keepalive: true })` when `sendBeacon` is unavailable or rejects the payload (e.g., above the per-browser 64 KB beacon limit)
- do **not** retry: anything still pending is requeued for the next session

Page-exit delivery is **best-effort**. The browser may kill the tab before the beacon ships. Treat it as a strong hint, not a guarantee.

Disable via:

```ts
{
  flushOnPagehide: false,   // default is true
}
```

### Manual flush

```ts
const result = await sdk.flush();
```

`flush()` uses steady-mode semantics: drain up to `batchSize`, attempt delivery once with in-line retries, return a `FlushResult`. See [API Reference / `flush`](./api-reference.md#flush).

## Web SDK: flush triggers summary

| Trigger | Mode | Behaviour |
| --- | --- | --- |
| Eager debounce (first 15s) | eager | Flushes 100ms after the last `track()`. |
| Batch size reached | steady | Flushes when queue length ≥ `batchSize`. |
| Steady interval | steady | Flushes every `steadyFlushIntervalMs` if queue non-empty. |
| `pagehide` / `visibilitychange` | urgent | `sendBeacon` with `fetch` keepalive fallback. |
| Manual `flush()` | steady | Drain once and attempt delivery. |

## Node SDK: flush lifecycle

The Node SDK has a simpler model:

- Interval flush: every `flushIntervalMs` (default 5s). Set to `0` to disable.
- Batch-size flush: when the queue length reaches `batchSize` (default 50), a flush is kicked off in the background.
- Manual `flush()`: same semantics as Web — drain up to `batchSize`, attempt delivery once with in-line retries.
- `close()`: drain repeatedly until empty or `shutdownTimeoutMs` elapses. See [API Reference / `close`](./api-reference.md#close-node-only-public-lifecycle).

There is no eager mode or urgent mode in the Node SDK. Backend producers do not have the short-visit problem the eager mode is designed for, and they do not have a page-exit moment that needs `sendBeacon`.

The interval timer is `unref()`-ed where supported, so the SDK does not by itself keep the Node event loop alive.

## Concurrent flushes

Both SDKs serialise `flush()` calls. The second call waits for the first to complete and then runs against the remaining queue. If the first call drained the queue, the second returns `{ delivered: 0, queued: 0, dropped: 0 }` and exits.

This means:

```ts
// These all return the same effective result — there is at most one
// in-flight flush at a time.
await Promise.all([sdk.flush(), sdk.flush(), sdk.flush()]);
```

## `event_id` preservation across retries

A retried event keeps its original `event_id`. The ingester's 15-minute ingress dedupe relies on this: a retry storm of the same event will collapse on a single accept rather than producing duplicates downstream. See [Ingestion and SDKs / Deduplication](../architecture/04-ingestion-and-sdks.md#deduplication).

If an event ends a flush still pending (retryable failure, retries not exhausted), the SDK returns it to the head of the queue with its existing `event_id`. The next flush picks it up.

## Node queue adapter guidance

The Node SDK exposes a `QueueAdapter` interface. The default `MemoryQueueAdapter` is bounded in-memory. To plug in a durable backend:

```ts
import { PolarisNodeSdk, type QueueAdapter, type QueuedEvent } from "@polaris/node-sdk";

class MyDurableQueue implements QueueAdapter {
  async enqueue(event: QueuedEvent): Promise<boolean> {
    // Append to durable store. Return false on overflow.
    return true;
  }
  async size(): Promise<number> {
    return 0;
  }
  async drain(max: number): Promise<QueuedEvent[]> {
    return [];
  }
  async requeue(events: readonly QueuedEvent[]): Promise<void> {
    // Push back to head, preserving order.
  }
  async close(): Promise<void> {
    // Flush durable state.
  }
}

const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
  queue: new MyDurableQueue(),
});
```

Implementation contract:

- `enqueue` returns `true` when the event was accepted, `false` when the queue is full and rejected the event. The SDK fires `onDrop` with `queue_overflow` on `false`.
- `drain(max)` returns up to `max` events from the head. The caller (the SDK core) owns the events until it either commits delivery or returns them via `requeue`.
- `requeue` returns events to the head of the queue, preserving order. Implementations must keep the original `event_id` so retries dedupe correctly at the ingester.
- `close()` is optional. Use it to flush durable state during SDK shutdown.

Critical operational notes:

- Durable adapters that survive process crashes should still respect the same `maxSize` budget. An unbounded durable queue under retry storm can outpace ingester capacity.
- Do **not** treat `requeue` as a free retry. Retries cost ingester budget; a misbehaving event will retry forever if the adapter never times it out.
- Operators wanting at-least-once delivery from a backend should emit from their own application outbox (a transactional row in the same DB as the business mutation) and call the SDK as a transport. The SDK is not a queue durability solution.

## Web SDK: never use cookies for events

Cookies are never used for event queues. Sites that try to bridge an event over a cookie hit per-domain cookie size limits, leak event content into request headers, and confuse the identity layer. The Web SDK enforces this rule by not exposing a cookie-backed queue at all.

## Backpressure

Both SDKs apply backpressure by bounding the queue. When the queue is full:

- Web: overflow drops by priority (oldest `low` first, then `normal`, then `high`). See [Priority and Overflow](./priority-and-overflow.md).
- Node: overflow rejects new events; the producer can choose to drop, delay, or shed.

Neither SDK applies backpressure by slowing `track()` calls. `track()` returns as soon as the event is enqueued (or dropped); it never blocks on the network.
