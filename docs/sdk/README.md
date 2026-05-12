# Polaris SDK Handbook

This handbook is the operator-facing reference for the Polaris SDKs. It tells you how to install, configure, and run the Web and Node SDKs against a Polaris ingester.

Polaris ships two first-party SDKs:

- `@polaris/web-sdk` for browser producers
- `@polaris/node-sdk` for backend producers

Both are thin transport and identity helpers. They are not analytics engines: they do not enrich events, resolve identity, attribute, call vendor APIs, or own schema governance. The ingester remains the authoritative validator. See [SDK Standards](../architecture/10-sdk-standards.md) for the architectural rationale; this handbook is the operator's view.

## Navigation

- [Installation](./installation.md) — install/import, script-tag usage, inline loader
- [Initialization](./initialization.md) — configuration options for both SDKs
- [API Reference](./api-reference.md) — `track`, `identify`, `reset`, `flush`, `close`
- [Explicit `page.viewed`](./explicit-events.md) — there is no auto page tracking
- [Identity](./identity.md) — layered persistence, capability detection, session rotation
- [Queue and Flush](./queue-and-flush.md) — queue internals and the three flush phases
- [Priority and Overflow](./priority-and-overflow.md) — `low|normal|high` and eviction policy
- [Retries and Errors](./retries-and-errors.md) — exponential backoff, jitter, reason codes
- [Diagnostics](./diagnostics.md) — callbacks, debug logging, isolation
- [WebView and Mobile](./webview-and-mobile.md) — best-effort delivery in embedded browsers
- [Governance](./governance.md) — `schema_version`, deprecation, forbidden fields, consent
- [Troubleshooting](./troubleshooting.md) — common pitfalls and how to diagnose them

## Quickstart

### Web (ESM)

```ts
import { PolarisWebSdk } from "@polaris/web-sdk";

const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { id: "checkout-app" },
});

await sdk.track("page.viewed", {
  path: window.location.pathname,
  title: document.title,
});
```

### Node

```ts
import { PolarisNodeSdk } from "@polaris/node-sdk";

const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
});

await polaris.track("payment.approved", {
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
});

await polaris.flush();
await polaris.close();
```

## What the SDK Does and Does Not Do

The SDKs **do**:

- generate UUIDv7 `event_id`s and preserve them across retries
- persist `anonymous_id` and `session_id` (Web); accept caller-supplied identity (Node)
- batch events and flush over HTTPS to the ingester
- retry transient transport failures with exponential backoff and jitter
- expose diagnostic callbacks (`onDrop`, `onRetry`, `onFlush`, `onError`, `onDiagnostic`)
- enforce basic envelope/client-side validation (event-name shape, properties type, etc.)

The SDKs **do not**:

- auto-fire `page.viewed` on navigation
- bundle the event catalog
- validate event-specific `properties` against catalog schemas
- enrich events with GeoIP, identity resolution, or attribution
- call vendor APIs
- automatically emit diagnostic events to Polaris
- use third-party cookies or fingerprinting

## Cross-Reference

- [Event Contract](../architecture/01-event-contract.md) — canonical envelope, `schema_version`, forbidden-field policy
- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md) — ingester responsibilities, batch response shape, dedupe
- [SDK Standards](../architecture/10-sdk-standards.md) — full architectural ruleset
