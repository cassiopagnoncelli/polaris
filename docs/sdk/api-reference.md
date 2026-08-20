# API Reference

The canonical reference for the four public SDK methods. Behaviour matches `sdks/web/src/sdk.ts` and `sdks/node/src/sdk.ts`.

```text
track(event, properties, options?)
identify(customerId, traits?)
reset(options?)
flush()
close()                              // Node only; Web exposes it but Node is the canonical lifecycle
```

The Web SDK additionally exposes identity-introspection helpers (`getCapability`, `getDiagnostics`, `getEnvelopeIdentity`, `getIdentityManager`); the Node SDK exposes `getIdentity()`. These are informational and described in [Identity](./identity.md).

## `track`

Append an event to the local queue and return its `event_id`. The promise resolves once the event is durably enqueued; delivery happens out of band.

### Web

```ts
public async track(
  event: string,
  properties?: Record<string, unknown>,
  options?: TrackOptions,
): Promise<string>;
```

`TrackOptions`:

```ts
interface TrackOptions {
  readonly context?: Partial<Envelope["context"]>;
  readonly occurredAt?: Date | string;
  readonly schemaVersion?: number;          // default 1
  readonly consent?: Envelope["consent"];
  readonly privacy?: Envelope["privacy"];
  readonly priority?: "low" | "normal" | "high";  // default "normal"
}
```

### Node

```ts
public async track(
  event: string,
  properties?: Record<string, unknown>,
  options?: TrackOptions,
): Promise<string>;
```

`TrackOptions` (Node, with caller-supplied identity overrides):

```ts
interface TrackOptions {
  readonly identity?: IdentityOverrides;
  readonly context?: Partial<Envelope["context"]>;
  readonly occurredAt?: Date | string;
  readonly schemaVersion?: number;
  readonly consent?: Envelope["consent"];
  readonly privacy?: Envelope["privacy"];
}

interface IdentityOverrides {
  readonly anonymous_id?: string | null;
  readonly session_id?: string | null;
  readonly customer_id?: string | null;
  readonly device_id?: string | null;
}
```

The Node SDK has no `priority` option — there is no overflow eviction policy, just rejection at the bounded queue.

### Behaviour

- The SDK assigns a UUIDv7 `event_id` and stamps `occurred_at` (defaults to now), `source`, `identity`, `context`, `properties`, and optional `consent`/`privacy`.
- The promise resolves with the `event_id` once the event lands in the queue.
- `track()` does **not** throw on queue overflow; it fires `onDrop` with reason `queue_overflow` and returns the event ID anyway (Web SDK; the Node SDK does the same).
- Validation errors throw synchronously before any side effect: invalid event name, invalid `properties` type, invalid `occurredAt`, invalid `schemaVersion`, invalid `priority`. See [Troubleshooting](./troubleshooting.md).

### Event name rules

Event names are validated against the shared regex in `@polaris/spec` (`eventNameRegex`). The contract is:

- lowercase ASCII
- dot-separated, at least two segments
- each segment is `snake_case`
- at most 128 characters total
- describes a fact (`payment.approved`), not a command (`process_payment_now`)

See [Event Contract / Event Naming](../architecture/01-event-contract.md#event-naming).

### Examples

```ts
// Minimal call.
await sdk.track("checkout.started");

// With properties.
await sdk.track("payment.approved", {
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
});

// Web: with a custom priority.
await sdk.track(
  "ui.heartbeat",
  { ms_since_load: 1200 },
  { priority: "low" },
);

// With consent metadata attached to a single event.
await sdk.track(
  "marketing.email_opened",
  { campaign_id: "spring_promo" },
  {
    consent: { analytics: true, marketing: true, personalization: true },
  },
);

// Node: per-event identity override (rare; usually set via identify()).
await polaris.track(
  "payment.approved",
  { amount: 12990, currency: "BRL" },
  { identity: { customer_id: "cus_123" } },
);
```

## `identify`

Associate a `customer_id` with subsequent events.

### Web

```ts
public identify(customerId: string, traits?: IdentifyTraits): void;
```

- Sets `identity.customer_id` for all future events.
- Touches the activity clock, which resets the 30-minute inactivity timer.
- **Emits `user.identified`** carrying `traits` as the event properties. The identity stage merge-patches those properties into the profile store (last-write-wins per key) and bumps the profile's `traits_version`.
- Identity is set **before** the event is built, so the emitted envelope carries `anonymous_id` and `customer_id` together. That co-occurrence is what lets the resolver bind both identifiers to one profile — it is the reason the ordering is not an implementation detail.
- Fire-and-forget: `identify()` stays synchronous and never throws on a queue problem. Failures surface through `onError`, like any other dropped event.
- `traits` is optional. Omitting it emits the event with empty properties, which still performs the identifier binding.

### Node

```ts
public identify(customerId: string, traits?: IdentifyTraits): void;
```

Same behaviour as Web: sets `identity.customer_id` and emits `user.identified` with the traits.

> **Changed.** Earlier versions accepted `traits` and discarded them, because no authoritative event existed in the catalog to carry them — the guidance was to call `track("user.identified", ...)` yourself. `user.identified` v1 is now registered, so the SDK does it. If your code already emits that event manually after `identify()`, you will now send two; drop the manual call.

### Validation

`customerId` must be a non-empty string up to 128 characters. The SDK throws `ValidationError` synchronously on bad input.

### Example

```ts
// User logs in.
sdk.identify("cus_123");

// Next event includes customer_id alongside the existing anonymous_id —
// this overlap is the authoritative link for the identity resolver.
await sdk.track("session.continued");
```

## `reset`

Clear the current customer and rotate session identity.

```ts
public reset(options?: ResetOptions): void;

interface ResetOptions {
  readonly anonymous?: boolean;   // default true
}
```

### Default behaviour

```ts
sdk.reset();
// clears customer_id
// rotates session_id
// rotates anonymous_id
```

### Keep anonymous continuity

```ts
sdk.reset({ anonymous: false });
// clears customer_id
// rotates session_id
// keeps anonymous_id
```

The default favours shared-device/logout safety. The opt-out exists for products that deliberately want anonymous continuity across logout (e.g., a content site that distinguishes session boundaries but does not consider logout a new visitor).

`reset` is synchronous and never throws.

### Example

```ts
// User logs out.
sdk.reset();

// Or: log out but keep tracking the same anonymous user for personalisation.
sdk.reset({ anonymous: false });
```

## `flush`

Force the SDK to attempt delivery of queued events now.

### Web

```ts
public flush(): Promise<FlushResult>;

interface FlushResult {
  readonly delivered: number;
  readonly queued: number;
  readonly dropped: number;
  readonly mode: "steady" | "urgent";
}
```

### Node

```ts
public flush(): Promise<FlushResult>;

interface FlushResult {
  readonly delivered: number;
  readonly queued: number;
  readonly dropped: number;
}
```

(Node has no `mode` field — Node does not have an urgent/sendBeacon path.)

### Behaviour

- `flush()` drains up to `batchSize` events and attempts delivery once.
- Concurrent `flush()` calls are serialised: the second call waits for the first to complete and observes only its own slice of work (it may end up delivering zero events if the first drained the queue).
- Permanent rejections (closed-set reason codes) fire `onDrop` and are not retried.
- Retryable failures are retried in-line up to the configured cap. Events that still have not landed are returned to the queue with their original `event_id` so a later `flush()` (or interval-driven flush) can try again.
- Page-exit delivery (Web only) uses `sendBeacon` with a `fetch(..., { keepalive: true })` fallback; this is best-effort and is **not** guaranteed.

### When to call

- Web: usually never. The lifecycle controller flushes automatically. Call manually if you want a synchronous-feeling acknowledgement before navigation in a SPA.
- Node: at process shutdown, before `close()`. The interval-driven flush handles steady state.

### Example

```ts
const result = await sdk.flush();
console.log(result);
// { delivered: 12, queued: 0, dropped: 0, mode: "steady" }
```

## `close` (Node-only public lifecycle)

Stop accepting new events, drain the queue with a bounded timeout, and release transport resources.

```ts
public async close(): Promise<void>;
```

The Node SDK considers `close()` part of the public surface; it is how applications signal graceful shutdown.

### Behaviour

- `close()` is idempotent.
- Subsequent calls to `track()`, `identify()`, or `reset()` throw.
- The interval timer is stopped.
- Pending events are drained repeatedly until the queue is empty or `shutdownTimeoutMs` elapses (default 5 seconds).
- On timeout, remaining queued events plus anything still in-flight at the transport are dropped with reason `shutdown_timeout`. A `shutdown_timeout` diagnostic is emitted.
- Queue and transport `close()` hooks run after the drain.
- Process signal handlers registered by `autoFlushOnShutdown: true` are torn down.

### Example

```ts
// Graceful shutdown in a service.
await polaris.close();
process.exit(0);
```

The Web SDK exposes a `close()` method too (used for SPA teardown), but the architectural contract for the Web SDK is page-exit delivery via the lifecycle controller, not explicit shutdown. See [Queue and Flush](./queue-and-flush.md).

## What does **not** exist

- No `page()` helper. Page views are explicit `track("page.viewed", ...)` calls. See [Explicit `page.viewed`](./explicit-events.md).
- No `group()`, `alias()`, or `screen()` methods.
- No autocapture (clicks, forms, scroll depth).
- No automatic identify-event emission.
- No vendor-specific helpers (e.g., no `trackPurchase` shorthand).
- No automatic diagnostic events sent to Polaris. Diagnostics are callbacks only. See [Diagnostics](./diagnostics.md).

If you find yourself wanting one of these, the answer is one of: write the producer-side helper in your application, build it as a processor downstream, or open a task card to evaluate adding it to the SDK.

## Cross-reference

- [Event Contract](../architecture/01-event-contract.md) — envelope, naming, schema rules.
- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md) — batch response, reason codes.
- [SDK Standards](../architecture/10-sdk-standards.md) — full architectural ruleset.
