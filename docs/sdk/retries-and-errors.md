# Retries and Errors

This page covers how the SDKs handle transport failures and how the ingester's per-event response codes drive retry vs drop decisions.

## Retry policy

Both SDKs use **exponential backoff with bidirectional jitter**.

Default policy:

| Field | Default (Web) | Default (Node) |
| --- | --- | --- |
| `maxRetries` / `maxAttempts` | `3` retries | `5` attempts (initial + retries) |
| `initialDelayMs` | `500` | `500` |
| `maxDelayMs` | `30_000` | `30_000` |
| `backoffMultiplier` | `2` (exponential doubling) | `2` |
| `jitterRatio` | `0.2` (±20%) | `0.2` (±20%) |

Notes on the field-name difference:

- The Web SDK's `RetryPolicy.maxRetries` is the number of retries *after* the initial attempt. With the default `3`, the SDK makes up to 4 attempts total per flush.
- The Node SDK's `RetryPolicy.maxAttempts` is the **total** number of attempts (initial + retries). With the default `5`, the SDK makes up to 5 attempts total per flush.

Tune via the constructor:

```ts
// Web — half the retries.
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  retry: {
    maxRetries: 1,
    initialDelayMs: 250,
    maxDelayMs: 5_000,
  },
});

// Node — slower backoff for chatty backends.
const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
  retry: {
    maxAttempts: 3,
    initialDelayMs: 2_000,
    backoffMultiplier: 3,
    jitterRatio: 0.1,
  },
});
```

## Backoff schedule

For attempt `n` (1-indexed) the base delay is:

```text
base = initialDelayMs * backoffMultiplier^(n - 1)
capped = min(base, maxDelayMs)
jitter = capped * jitterRatio * (random() * 2 - 1)   // ± jitter
delay = clamp(capped + jitter, [0, maxDelayMs])
```

With the defaults (initial 500ms, multiplier 2, jitter 20%):

| Attempt | Base | Window |
| --- | --- | --- |
| 1 | 500 ms | 400–600 ms |
| 2 | 1000 ms | 800–1200 ms |
| 3 | 2000 ms | 1600–2400 ms |
| 4 | 4000 ms | 3200–4800 ms |
| 5 | 8000 ms | 6400–9600 ms |

Bidirectional jitter (the `± jitterRatio` range) spreads retries on both sides of the deterministic schedule. The architectural reason is to avoid synchronised retry storms when many SDK instances backed off at the same `initialDelayMs` — the standard pattern of "delay + uniform jitter ∈ [0, base]" only spreads on the upper side.

## What gets retried

The retry coordinator distinguishes transport-layer failures from per-event response codes.

### Transport-layer failures (whole batch retried)

The SDK throws `TransportError(retryable: boolean, status?, code?)` for transport-layer outcomes:

| HTTP status / error | Retryable? |
| --- | --- |
| `2xx` (parsed batch response) | per-event basis (see below) |
| `4xx` except `408` and `429` | **no** — permanent |
| `408` Request Timeout | yes |
| `429` Too Many Requests | yes |
| `5xx` | yes |
| Network error / DNS / TCP / TLS | yes |
| Request timeout (`requestTimeoutMs` elapsed) | yes |

A whole-batch retryable failure retries the entire batch on the next attempt. A whole-batch permanent failure drops every event in the batch with reason `permanent_failure`.

### Per-event response codes

When the ingester returns `2xx`, the response body has the partial-acceptance shape from [Ingestion and SDKs / Batch Failure Behavior](../architecture/04-ingestion-and-sdks.md#batch-failure-behavior):

```json
{
  "accepted": [
    { "event_id": "evt_1", "status": "accepted" }
  ],
  "rejected": [
    {
      "event_id": "evt_2",
      "status": "rejected",
      "reason": "schema_validation_failed"
    }
  ]
}
```

The SDK partitions the rejected entries into retryable and permanent based on the closed-set reason codes:

#### Permanent reason codes (never retried)

These reasons are baked into the transport layer's `PERMANENT_REJECTION_REASONS` set:

```text
schema_validation_failed
unsupported_schema_version
schema_version_sunset
unknown_event
invalid_properties
invalid_envelope
forbidden_field_rejected
```

When an event is rejected with one of these reasons, the SDK fires `onDrop(entry, "permanent_failure")` and does not retry it. The producer has a bug; retries cannot fix it.

#### Retryable reason codes

Any reason not in the permanent set is treated as retryable. The transport layer also tags the entry's `retryable` flag, which the SDK consults if the ingester signals retryability explicitly.

If an event remains pending after the retry cap is exhausted, it is dropped with reason `permanent_failure` (the in-line retry budget for this flush ran out; the event is not requeued for a later flush, because the in-line budget is the SDK's whole retry budget — see "Why retries don't requeue forever" below).

If an event is **still pending** but **retries have not been exhausted** at the end of a flush (e.g., the flush was interrupted mid-schedule), the SDK returns it to the queue with its original `event_id` so the next flush attempt picks it up.

## `event_id` preservation

A retried event keeps its original `event_id`. This is required for the ingester's 15-minute ingress dedupe window to collapse retry storms onto a single accepted record — see [Ingestion and SDKs / Deduplication](../architecture/04-ingestion-and-sdks.md#deduplication).

Implication: a custom `QueueAdapter` for the Node SDK **must** preserve `event_id` across `drain` → `requeue` round-trips. The default `MemoryQueueAdapter` does this; downstream durable adapters must too.

## Why retries don't requeue forever

The retry coordinator retries in-line within a single `flush()` call. If the cap is hit, remaining events are dropped, not requeued.

Reasons:

- An event that fails repeatedly is almost always a producer-side issue. Requeueing it forever turns the SDK into an infinite write-amplifier against the ingester.
- The ingester's ingress dedupe is a 15-minute window. Beyond that, an event that retries dozens of times can show up as duplicates.
- The Node SDK's `close()` has a `shutdownTimeoutMs`; events that cannot drain within that window are dropped with `shutdown_timeout` rather than blocking process exit indefinitely.

If you need at-least-once delivery beyond the SDK's in-line retry budget, use a durable upstream queue (an application outbox) and treat the SDK as the wire transport. The SDK is not a queue durability solution.

## Urgent mode (Web): no retries

A `pagehide` flush triggers an **urgent** mode flush. Urgent flushes do not retry in-line — the tab is racing the unload. If the urgent flush fails, the events are returned to the queue so the next session can retry them.

This is also why `flushOnPagehide` is a hint, not a guarantee. The browser may kill the tab before the beacon ships.

## Observing retries

Wire `onRetry` to your local logging:

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: "POLARIS_API_KEY",
  source: { id: "checkout-app" },
  diagnostics: {
    onRetry: (entry, attempt, error) => {
      console.warn("polaris retry", {
        attempt,
        event: entry.payload.event,
        event_id: entry.payload.event_id,
        error: error.message,
      });
    },
    onDrop: (entry, reason) => {
      console.warn("polaris drop", {
        reason,
        event: entry.payload.event,
        event_id: entry.payload.event_id,
      });
    },
  },
});
```

The diagnostic `kind: "retry"` event also fires on every retry attempt (with attempt number and retryability) via `onDiagnostic`.

## Errors thrown synchronously

Some errors throw synchronously from `track()` and are *not* retried — they are producer bugs surfaced before the event ever enters the queue:

- `ValidationError("invalid_event_name", ...)` — the event name does not match `eventNameRegex`
- `ValidationError("invalid_properties", ...)` — `properties` is not a plain object
- `ValidationError("invalid_occurred_at", ...)` — `occurredAt` is not parseable
- `ValidationError("invalid_schema_version", ...)` — `schemaVersion` is not a positive integer
- `ValidationError("invalid_priority", ...)` — Web only; priority is not `"low" | "normal" | "high"`
- `ValidationError("invalid_customer_id", ...)` — `identify(customerId)` got a non-string or empty string

Catch and surface these in your producer-side error handler. See [Troubleshooting](./troubleshooting.md).

## Errors thrown after `close()`

Both SDKs throw if `track`, `identify`, or `reset` is called after `close()`:

```text
Error: PolarisWebSdk: cannot use SDK after close()
Error: PolarisNodeSdk: cannot use SDK after close()
```

This is intentional. Make sure your application's shutdown order calls Polaris last.
