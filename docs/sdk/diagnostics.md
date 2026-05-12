# Diagnostics

The SDKs surface operational state through optional callbacks. They do **not** automatically emit diagnostic events to Polaris. The architectural rationale is in [SDK Standards / SDK Diagnostics](../architecture/10-sdk-standards.md#sdk-diagnostics); this page is the operator's view.

## Callbacks

Both SDKs accept the same `DiagnosticCallbacks` shape:

```ts
interface DiagnosticCallbacks {
  onError?: (error: Error) => void;
  onDrop?: (entry: QueueEntry | QueuedEvent, reason: DropReason) => void;
  onRetry?: (entry: QueueEntry | QueuedEvent, attempt: number, error: Error) => void;
  onFlush?: (result: FlushResult) => void;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}
```

(The Web SDK passes `QueueEntry` to `onDrop` / `onRetry`; the Node SDK passes the raw `QueuedEvent`. The structural shape is otherwise identical.)

Wire whatever subset you need:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  diagnostics: {
    onError: (err) => console.error("polaris error", err),
    onDrop: (entry, reason) => console.warn("polaris drop", reason, entry.payload.event),
    onRetry: (entry, attempt) => console.info("polaris retry", attempt, entry.payload.event),
    onFlush: (result) => console.debug("polaris flush", result),
    onDiagnostic: (d) => console.debug("polaris diagnostic", d.kind, d.message, d.detail),
  },
});
```

### Callback isolation

A throwing callback **does not** bring down the SDK. The SDK catches any exception thrown from a callback. `onError` is the catch-all for callback failures, transport errors, and unexpected runtime errors.

If `onError` itself throws, the exception is swallowed. This is deliberate: a misbehaving producer-supplied callback must not take the SDK offline.

You can rely on this behaviour. Wire `onError` to your own logging and forget; the SDK's internals will not be affected if your logging stack hiccups.

## Reasons surfaced via `onDrop`

### Web SDK

```ts
type DropReason =
  | "queue_overflow"
  | "permanent_failure"
  | "retry_exhausted"
  | "validation_failed";
```

### Node SDK

```ts
type DropReason =
  | "queue_overflow"
  | "permanent_failure"
  | "shutdown_timeout"
  | "validation_failed";
```

The Web SDK has `retry_exhausted` (in-line retry budget hit during a flush); the Node SDK has `shutdown_timeout` (the `close()` drain timed out and dropped what remained). The reasons reflect the SDKs' lifecycle differences.

## `Diagnostic` kinds

The `Diagnostic` record surfaces lower-level events to `onDiagnostic`:

### Web SDK

```ts
type DiagnosticKind =
  | "queue_layer_selected"
  | "queue_pressure"
  | "queue_overflow"
  | "retry"
  | "flush"
  | "validation_failed"
  | "transport_error"
  | "lifecycle_mode_change";
```

### Node SDK

```ts
type DiagnosticKind =
  | "queue_pressure"
  | "queue_overflow"
  | "retry"
  | "flush"
  | "validation_failed"
  | "shutdown_timeout"
  | "transport_error";
```

Each `Diagnostic` is `{ kind, message, detail? }` — a typed message that the SDK emits when it crosses an operationally interesting boundary.

| Kind | Triggered when |
| --- | --- |
| `queue_layer_selected` (Web) | The SDK picks its initial queue layer (IndexedDB / localStorage / memory). |
| `queue_pressure` | Queue length approaches the configured cap. |
| `queue_overflow` | The queue rejected or evicted an event. |
| `retry` | A flush attempt failed and is about to back off. |
| `flush` | A flush completed (also reported via `onFlush`). |
| `validation_failed` | Client-side validation rejected an event. |
| `transport_error` | A non-retryable transport error caused a batch drop. |
| `lifecycle_mode_change` (Web) | Eager→steady mode transition. |
| `shutdown_timeout` (Node) | `close()` drain hit `shutdownTimeoutMs`. |

The `detail` object varies by kind. Treat it as an open record — fields may be added without bumping a version, never renamed or removed without coordination.

## Debug logging vs callbacks

There is no separate "debug log" verbosity dial. Diagnostics flow exclusively through the callbacks. Wire `onDiagnostic` to a debug-level logger; toggle the logger's level in your application config:

```ts
import { pino } from "pino";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  diagnostics: {
    onDiagnostic: (d) => log.debug({ kind: d.kind, ...d.detail }, d.message),
    onError: (err) => log.error({ err }, "polaris error"),
    onDrop: (entry, reason) => log.warn({ reason, event_id: entry.payload.event_id }, "polaris drop"),
  },
});
```

## The SDK does not auto-emit diagnostic events

The SDK does **not** post diagnostic information to a Polaris endpoint. Diagnostic callbacks are local-only.

The architecture doc describes an *optional* opt-in diagnostic stream that emits to `polaris.diagnostics.events`. That stream is **not** implemented in the SDKs today — see [SDK Standards / SDK Diagnostics](../architecture/10-sdk-standards.md#sdk-diagnostics) for the eventual design.

If you want SDK operational state visible in Polaris, route your application's `onDiagnostic` log into the same observability stack as the rest of your service. Do not try to call `sdk.track("polaris.queue.overflow", ...)` to emulate the opt-in stream — that would mix operator telemetry into the canonical event catalog.

## What never appears in diagnostics

- Raw event payload bodies. `onDrop` / `onRetry` hand back the queue entry so your callback can read what it needs; the SDK itself never logs the `properties` content into diagnostics.
- Secrets, API keys, or cookie values.
- Customer PII beyond whatever `identity` IDs you elected to inspect in your callback.

This matches the architecture rule: diagnostics must not include secrets or sensitive raw payloads. See [SDK Standards / SDK Diagnostics](../architecture/10-sdk-standards.md#sdk-diagnostics).

## Recommended wiring

### Minimum

```ts
diagnostics: {
  onError: (err) => log.error({ err }, "polaris error"),
}
```

`onError` covers the catch-all path: transport failures that exhausted retries, unexpected runtime errors, callback misbehaviour. Set this up before anything else.

### Useful additions

```ts
diagnostics: {
  onError: (err) => log.error({ err }, "polaris error"),
  onDrop: (entry, reason) => {
    log.warn({
      reason,
      event: entry.payload.event,
      event_id: entry.payload.event_id,
    }, "polaris dropped event");
  },
  onFlush: (result) => log.debug({ ...result }, "polaris flush"),
}
```

This tells you when events are being dropped (which is almost always operationally interesting) and lets you graph flush throughput.

### Full pressure visibility

For services where ingest reliability is critical, also wire `onRetry` and `onDiagnostic`:

```ts
diagnostics: {
  onError: ...,
  onDrop: ...,
  onFlush: ...,
  onRetry: (entry, attempt, err) => {
    log.warn({
      attempt,
      event_id: entry.payload.event_id,
      error: err.message,
    }, "polaris retry");
  },
  onDiagnostic: (d) => {
    log.debug({ kind: d.kind, ...d.detail }, d.message);
  },
}
```

## Web SDK: identity diagnostics

The Web SDK additionally exposes capability/diagnostic snapshots through identity helpers:

```ts
sdk.getCapability();
// { available, primary, degraded, webview, secureContext }

sdk.getDiagnostics();
// { capability, currentLayer, lastActivityAt }
```

Use these at startup to report the storage layer to your observability stack. The `degraded` flag is a particularly useful indicator: a session-only or memory-only fallback signals constrained or private-mode browsing.

## Node SDK: identity helper

```ts
polaris.getIdentity();
// { anonymous_id, session_id, customer_id, device_id }
```

`getIdentity` returns a frozen snapshot of the SDK's identity state. Use it to correlate Polaris events with your own logs or traces without firing a Polaris event just to inspect the identity.
