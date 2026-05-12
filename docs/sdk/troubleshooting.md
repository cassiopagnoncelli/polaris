# Troubleshooting

A short list of common problems and how to diagnose them.

## "I called `track()` and nothing arrived at the ingester"

The most common causes:

### 1. You used `new PolarisWebSdk(...)` instead of `await PolarisWebSdk.create(...)`

The synchronous constructor defaults to a memory queue and does not probe IndexedDB. The async `create()` builder is the recommended path:

```ts
// Wrong: synchronous fallback uses memory queue and a sync defaults path.
const sdk = new PolarisWebSdk({ endpoint, apiKey, source: { id: "web" } });

// Right: probes IndexedDB asynchronously and selects the strongest layer.
const sdk = await PolarisWebSdk.create({
  endpoint,
  apiKey,
  source: { id: "web" },
});
```

The synchronous path still delivers events; it just does not get the layered persistence. If you are seeing zero delivery in a Web environment, the cause is almost always one of the next items.

### 2. You omitted `endpoint` or `apiKey`

When both are missing, the SDK constructs without a transport. `track()` accepts events and `flush()` returns `{ delivered: 0, queued: N, dropped: 0, mode: "steady" }`. There is no error — by design, the SDK is constructible without a transport so test scaffolding can exercise the queue layer.

Check your construction:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: process.env.POLARIS_ENDPOINT!,
  apiKey: process.env.POLARIS_API_KEY!,
  source: { id: "checkout-app" },
});
```

If `POLARIS_ENDPOINT` or `POLARIS_API_KEY` resolve to `undefined`, the SDK silently runs without a transport. Surface the env-var requirement at your application bootstrap.

### 3. The endpoint is wrong

`endpoint` should point at the Polaris ingestion endpoint, including the path (e.g., `/v1/events`). The SDK does not append a path.

```ts
endpoint: "https://ingest.polaris.internal/v1/events"
```

Common mistakes:

- Pointing at `https://ingest.polaris.internal/` (no path)
- Pointing at a control-plane API URL instead of the ingester

### 4. The API key is for the wrong project/environment

API keys are bound to project + environment + source. A staging key against the production ingester is rejected with a transport-layer 4xx and the events are dropped with reason `permanent_failure`.

Wire `onError` and `onDrop` to confirm:

```ts
diagnostics: {
  onError: (err) => console.error("polaris error", err),
  onDrop: (entry, reason) => console.warn("polaris drop", reason, entry.payload.event),
}
```

### 5. The CORS origin is not allowed

Browser deliveries from an untrusted origin are blocked by the ingester's CORS configuration. The SDK surfaces this as a transport error in `onError`. Configure the source's allowed origins via the control plane.

## "Validation errors are throwing synchronously from `track`"

The SDK validates basic envelope/client constraints synchronously:

```text
ValidationError: invalid_event_name  — event must be lowercase snake_case, dot-separated, at least two segments, ≤128 chars
ValidationError: invalid_properties  — properties must be a plain object (not a Map, Array, class instance, or null)
ValidationError: invalid_occurred_at — occurredAt must be a Date or ISO string
ValidationError: invalid_schema_version — schemaVersion must be a positive integer
ValidationError: invalid_priority    — priority must be "low", "normal", or "high" (Web only)
ValidationError: invalid_customer_id — customerId must be a non-empty string ≤128 chars
```

These are producer bugs surfaced before the event enters the queue. Catch them at your call site:

```ts
import { ValidationError } from "@polaris/web-sdk";

try {
  await sdk.track("Track Purchase", {});
} catch (err) {
  if (err instanceof ValidationError) {
    console.error("polaris validation failed:", err.code, err.message);
  } else {
    throw err;
  }
}
```

Common mistake: a camelCase event name like `trackPurchase`. The catalog requires lowercase dotted snake_case (`purchase.completed`).

## "The Web SDK is in `memory` mode in private browsing"

Private/incognito modes disable IndexedDB or localStorage. The SDK falls back to memory and sets `capability.degraded = true`. Events do not survive navigation.

There is no fix at the SDK layer — the browser is enforcing privacy. Mitigations:

- Treat private-mode visits as ephemeral. The customer is signalling they want it that way.
- Capture campaign/click context every event so the downstream identity resolver can still link via URL parameters.
- Log `sdk.getCapability()` at startup so operators can see private-mode rates in their dashboards.

## "Events arrive but `customer_id` is null"

You forgot to call `identify(customerId)` before the event fired, or you called `reset()` between login and the event.

Confirm:

```ts
sdk.identify("cus_123");
console.log(sdk.getEnvelopeIdentity()); // customer_id should be "cus_123"
await sdk.track("session.continued");
```

Note that the downstream identity resolver treats the *first* event after `identify()` as the authoritative link (the `anonymous_id + customer_id` overlap on a single event). The SDK does not fire a synthetic identify event; the link travels via the next real event.

## "Events arrive with stale `session_id` after a long idle"

This is the SDK working as designed. Sessions rotate after 30 minutes of inactivity. The first event after a long idle gets a fresh `session_id`.

If you need a shorter or longer threshold:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint, apiKey,
  source: { id: "web" },
  identity: {
    sessionInactivityMs: 15 * 60 * 1000, // 15 minutes
  },
});
```

Do not set it below ~5 minutes — short thresholds make sessions noisy and the downstream sessionizer less useful.

## "The Node SDK is dropping events on shutdown"

The Node SDK's `close()` is bounded by `shutdownTimeoutMs` (default 5 seconds). If the queue cannot drain in that window, remaining events are dropped with reason `shutdown_timeout`.

Mitigations:

- Call `flush()` before `close()` to get a best-effort delivery first.
- Increase `shutdownTimeoutMs` if your service can afford a longer graceful shutdown.
- For critical events, emit from your application outbox, not from the SDK alone. The SDK is a wire transport, not a durability layer.

```ts
await polaris.flush();          // best-effort drain
await polaris.close();          // bounded drain + cleanup
```

## "The Node SDK keeps the event loop alive after I want to exit"

The interval timer is `unref()`-ed where supported, so the SDK should not by itself keep the loop alive. If your process refuses to exit:

- Make sure you actually called `await polaris.close()`.
- Make sure no other code (the HTTP server, a Kafka client, a Postgres pool) is keeping the loop alive. The SDK is rarely the actual blocker.

`autoFlushOnShutdown: true` registers `SIGTERM`/`SIGINT` handlers that call `close()`. Use it when your service does not have its own shutdown coordination.

## "I see `queue_overflow` drops under steady load"

Either the queue is genuinely too small or you are not flushing fast enough.

Checklist:

- Confirm `maxQueueSize` (Web default 1000, Node default 10000) is appropriate for your traffic.
- Confirm the ingester is reachable. Persistent transport failures grow the queue until overflow.
- Confirm your retry policy is not too aggressive. Long backoffs hold events in the queue.
- For Web: confirm `batchSize` (default 20) and `steadyFlushIntervalMs` (default 5000ms) suit your event rate.

For Web, drops under overflow follow the priority order (oldest `low` first, then `normal`, then `high`). Mark genuinely-important events `priority: "high"` so they survive eviction. See [Priority and Overflow](./priority-and-overflow.md).

## "`onError` fires with a `TransportError`"

The error includes a `retryable` flag and (when set) an HTTP `status`:

```ts
import { TransportError } from "@polaris/web-sdk";
// or "@polaris/node-sdk" — both packages export TransportError

diagnostics: {
  onError: (err) => {
    if (err instanceof TransportError) {
      console.error("transport", {
        retryable: err.retryable,
        status: err.status,
        code: err.code,
        message: err.message,
      });
    } else {
      console.error("polaris error", err);
    }
  },
}
```

Common statuses:

- `401` / `403` — API key mismatch or revoked. Permanent.
- `404` — endpoint URL wrong. Permanent.
- `408` / `429` — slow down or back off. Retryable.
- `500` / `502` / `503` / `504` — ingester transient failure. Retryable.

If retries exhaust without success, the events are dropped with reason `permanent_failure` and the error surfaces via `onError`.

## "Diagnostics are firing for events I am sure are fine"

`onRetry` fires once per attempt, even on transient blips that the SDK recovers from. Log them at debug level, not error level. The same goes for `onDiagnostic` with `kind: "retry"`.

Only `onDrop` and `onError` indicate something actually went wrong from the SDK's perspective.

## "My callback threw and now I cannot see anything"

Producer-supplied callbacks are isolated. A throwing callback does not bring the SDK down — the exception is swallowed (and `onError` is fired, if defined). If you stopped seeing diagnostics after wiring a callback, check whether that callback is throwing:

```ts
diagnostics: {
  onDrop: (entry, reason) => {
    // Defensive: do not crash here.
    try {
      log.warn({ reason, event_id: entry.payload.event_id }, "polaris drop");
    } catch {
      // Swallow; we are already inside the SDK's swallow path.
    }
  },
}
```

In practice, the SDK's swallow path keeps things working; this is mostly relevant if your logger itself is broken in a noisy way.

## "I want to see what the SDK is doing right now"

Snapshot helpers:

```ts
// Web
sdk.getCapability();
sdk.getDiagnostics();
sdk.getEnvelopeIdentity();

// Node
polaris.getIdentity();
```

For queue state, wire `onFlush` and `onDiagnostic` with `kind: "queue_pressure"`:

```ts
diagnostics: {
  onFlush: (result) => log.debug({ ...result }, "polaris flush"),
  onDiagnostic: (d) => {
    if (d.kind === "queue_pressure") log.warn({ ...d.detail }, d.message);
  },
}
```

## When to file a task card instead of working around

Open a task card if:

- A reason code from the ingester is not documented in [Retries and Errors](./retries-and-errors.md).
- The SDK is dropping events that the ingester later accepted (a `permanent_failure` for an event you can prove was valid).
- A storage layer marked `available: true` consistently misbehaves (writes silently fail).
- A documented SDK option does not behave as the doc says.

Do not work around. The SDK contract is small; bugs in it should be fixed in the SDK, not patched per-application.
