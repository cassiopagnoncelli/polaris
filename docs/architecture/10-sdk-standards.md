# SDK Standards

## Purpose

Polaris SDKs are thin transport and identity helpers. They are not analytics engines.

SDKs help producers emit well-formed canonical events to the ingester. They do not enrich events, resolve identity, perform attribution, call vendors, own business workflows, or make schema governance decisions.

## Initial SDK Targets

Build these SDKs first:

```text
packages/web-sdk
packages/node-sdk
```

Deferred:

```text
packages/react-sdk
packages/ruby-sdk
packages/mobile-sdk
```

Framework and language-specific wrappers should build on the core SDK behavior after transport, identity/session handling, batching, retry, and ingestion compatibility are stable.

## Core Public API

SDK v1 exposes a small core API:

```ts
polaris.track(event, properties, options?)
polaris.identify(customerId, traits?)
polaris.reset(options?)
polaris.flush()
```

No automatic page tracking is enabled by default. Page views should be explicit:

```ts
polaris.track("page.viewed", {
  path: window.location.pathname,
  title: document.title
});
```

A `page()` helper or `autoTrackPageViews` option may be considered later, but it is not part of the v1 core API.

## Browser Identity Lifecycle

`track()` works before `identify()`.

Before identification, browser events include:

```json
{
  "identity": {
    "anonymous_id": "anon_abc",
    "session_id": "sess_xyz",
    "customer_id": null
  }
}
```

After:

```ts
polaris.identify("cus_123");
```

future events include:

```json
{
  "identity": {
    "anonymous_id": "anon_abc",
    "session_id": "sess_xyz",
    "customer_id": "cus_123"
  }
}
```

That explicit overlap is an authoritative identity link for the downstream identity resolver.

## Reset Behavior

`reset()` defaults to stronger user separation.

Default:

```ts
polaris.reset();
```

Behavior:

- clears `customer_id`
- rotates `session_id`
- rotates `anonymous_id`

To keep anonymous continuity:

```ts
polaris.reset({ anonymous: false });
```

Behavior:

- clears `customer_id`
- rotates `session_id`
- keeps `anonymous_id`

The default favors shared-device/logout safety. The opt-out supports products that deliberately want anonymous continuity across logout.

## Layered Browser Persistence

The Web SDK uses layered browser persistence tightly coupled to identity resolution.

Storage order:

```text
first-party cookie
localStorage mirror
sessionStorage fallback
in-memory fallback
```

Rules:

- First-party cookie is preferred when available.
- `anonymous_id` is mirrored into localStorage when available.
- sessionStorage is used as an additional fallback.
- In-memory identity is the last resort.
- SDK performs capability detection at startup.
- SDK records the storage layer used in diagnostic context.
- No third-party cookies.
- No fingerprinting.
- Cookie domain is configurable for subdomain sharing.
- Use `SameSite=Lax` by default.
- Use `Secure` when served over HTTPS.
- WebView and in-app browser environments are treated as degraded/best-effort.
- URL campaign/click IDs should be captured because storage may not persist in ad WebViews.

## Identity Resolution Coupling

SDK storage IDs are identity evidence, not canonical identity truth.

The identity resolver must treat storage layers as evidence quality signals:

```text
cookie-backed anonymous_id         stronger browser continuity signal
localStorage-only anonymous_id     normal browser continuity signal
sessionStorage anonymous_id        weaker session-only signal
memory-only anonymous_id           weakest transient signal
```

None of these alone authoritatively links an anonymous identity to a customer.

Authoritative links still come from explicit overlap:

```text
anonymous_id + customer_id
session_id + customer_id
documented business identifier + customer_id
```

WebView and ad embedded browser identities must be treated cautiously. Storage may be isolated, cleared, non-persistent, or unavailable. Campaign/click IDs and backend events become more important in those journeys.

## Session Lifecycle

The Web SDK uses 30-minute inactivity sessions.

Rules:

- A new `session_id` is created after 30 minutes of inactivity.
- Activity includes tracked events and explicit SDK activity markers.
- The SDK does not rotate sessions because campaign, UTM, referrer, or click IDs change.
- Campaign/click changes are captured in event context.
- Attribution interpretation belongs downstream, not in the SDK.
- Session IDs are transport/identity hints, not canonical attribution decisions.
- Identity/session processors may later reinterpret session windows from raw events during replay.

The SDK must not become an attribution engine.

## Client-Side Validation

SDKs perform basic envelope/client-side validation only.

SDKs validate:

- event name is a string
- properties is an object
- `occurred_at` is valid if supplied
- batch size limits
- estimated payload size limits
- identity/context shape

SDKs do not:

- bundle the full event catalog in v1
- perform authoritative event-specific `properties` validation
- decide whether an event is governed or experimental

The ingester remains the authoritative validator. Server validation errors are surfaced through per-event result codes.

## Web SDK Queue Model

The Web SDK uses an offline-first, lifecycle-aware event queue.

Core rule:

```text
track()
  -> assign event_id
  -> enqueue durably if possible
  -> flush according to lifecycle mode
```

Queue storage order:

```text
IndexedDB preferred
localStorage fallback
memory fallback
```

Cookies are never used for event queues.

## Web SDK Flush Lifecycle

The Web SDK has three transport phases:

```text
0-15s after SDK init       eager flush mode
after 15s                 steady batch mode
pagehide/manual flush      urgent flush mode
```

Defaults:

```text
startup_eager_flush_window_ms: 15000
startup_eager_flush_debounce_ms: 100
steady_flush_interval_ms: 5000
batch_size: 20
max_retries: 3
retry_backoff: exponential with jitter
flush_on_pagehide: true
```

Flush triggers:

- eager flush debounce
- batch size reached
- flush interval reached
- `pagehide` or visibility change where supported
- manual `flush()`

Use `navigator.sendBeacon` or `fetch(..., { keepalive: true })` where appropriate for page-exit flushes. Unload/page-exit delivery is best-effort and must not be treated as guaranteed.

## Retry Behavior

Rules:

- Preserve original `event_id` across retries.
- Retry transient request failures with exponential backoff and jitter.
- Do not retry permanent validation failures.
- Respect per-event batch response outcomes.
- Queue limits apply by count and bytes.

## Queue Priority and Overflow

Events may carry optional local delivery priority:

```text
low
normal
high
```

Default priority is `normal`.

When the queue is full, drop in this order:

```text
oldest low
oldest normal
oldest high
```

If all queued events are `high`, drop the oldest high-priority event only as a last resort.

Rules:

- Priority affects local SDK retention only.
- Priority does not change canonical event meaning.
- Priority does not control vendor routing.
- `track()` should not throw during normal queue overflow.
- Drops emit SDK diagnostics.

## SDK Diagnostics

SDKs expose optional diagnostic callbacks plus debug logging.

Optional callbacks:

```ts
onError(error)
onDrop(event, reason)
onRetry(event, attempt, error)
onFlush(result)
onDiagnostic(diagnostic)
```

Diagnostics should report:

- storage fallback
- queue pressure
- dropped events
- retry failures
- validation failures
- flush outcomes

SDKs do not emit automatic diagnostic events to Polaris by default.

An optional diagnostic stream is available for operators who want SDK-side operational signals (queue pressure, storage fallback, retry failures, dropped events, validation failures, flush outcomes) visible in the platform. When enabled:

- The SDK emits to a Polaris ingestion endpoint using the same canonical envelope.
- Event names live in the `polaris.diagnostics.*` namespace.
- Events route to the `polaris.diagnostics.events` topic (see [RabbitMQ Streams / SDK Diagnostics Topic](./03-rabbitmq-streams.md)).
- The diagnostic stream is not consumed by analytics processors or destination consumers.
- The SDK must never include canonical event payloads, user PII, or secrets in diagnostic events.

Diagnostic emission is opt-in per SDK installation. Default remains off.

Diagnostics must not include secrets or sensitive raw payloads.

## Browser Support

The Web SDK supports modern evergreen browsers plus extended best-effort WebView/in-app browser support.

Explicitly supported:

- recent Chrome
- recent Edge
- recent Firefox
- recent Safari

Important but degraded/best-effort:

- iOS WebViews
- Android WebViews
- in-app browsers
- ad embedded browsers

Rules:

- WebView support is important but not a hard reliability guarantee.
- Use layered persistence and transport fallbacks to maximize compatibility.
- Avoid heavy legacy polyfill burden.
- Do not use fingerprinting to compensate for storage limitations.
- Capture campaign/click context because persistent identity may fail in WebViews.
- Document known degradation modes clearly.

## Web SDK Distribution

Distribute the Web SDK as:

```text
ESM npm package
script-tag browser bundle
```

Rules:

- Provide ESM package for bundler-based apps.
- Provide IIFE/UMD-style browser bundle for script-tag installation.
- Define a small global API for script-tag usage.
- Keep the Web SDK small.
- Do not bundle the event schema catalog.
- Do not include vendor SDKs.
- Do not include fingerprinting libraries.
- Avoid heavy dependencies.

## Script Loader

The Web SDK provides an async script loader with a pre-init command queue.

Rules:

- Script-tag users get a lightweight inline loader snippet.
- The loader defines a temporary global API.
- Calls before full SDK load are queued.
- The full SDK loads asynchronously.
- Queued calls are drained after initialization.
- The loader supports early `track`, `identify`, `reset`, and `flush` calls.
- The snippet stays small and stable.
- The full SDK preserves event order for queued calls where possible.

## Node SDK

The Node SDK uses memory queue by default with pluggable durable queue adapters.

Rules:

- Default Node SDK queue is bounded in-memory.
- Node SDK supports batching, retry, interval flush, batch-size flush, and manual `flush()`.
- Preserve `event_id` across retries.
- Expose a queue adapter interface for durable backends later:
  - Redis
  - filesystem
  - custom
- Do not pretend the default Node SDK queue survives process crashes.
- Critical backend producers should use a durable queue adapter or emit from their own reliable job/outbox system.

## Node SDK Shutdown

The Node SDK uses explicit lifecycle shutdown.

Rules:

- SDK exposes `flush()` and `close()`.
- Applications should call `flush()` or `close()` during graceful shutdown.
- SDK does not register process signal handlers by default.
- Optional `autoFlushOnShutdown` may register shutdown hooks when explicitly enabled.
- Shutdown flush has a configurable timeout.
- The SDK should not block process exit indefinitely.

## SDK Handbook

Polaris SDKs ship with a full SDK handbook from day one.

The handbook should include:

- install/import
- script-tag usage
- initialization config
- public API reference
- `track` examples
- `identify`/`reset` lifecycle
- explicit `page.viewed` tracking
- identity/session behavior
- layered browser persistence
- WebView/in-app browser caveats
- offline-first queue internals
- eager flush and steady batch behavior
- queue overflow and priority policy
- diagnostic hooks
- browser compatibility matrix
- Node SDK examples
- Node shutdown behavior
- Node queue adapter guidance
- troubleshooting
- migration guides as SDKs evolve

