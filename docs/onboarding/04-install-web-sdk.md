# Phase 4 — Install the Web SDK

The Polaris Web SDK (`@polaris/web-sdk`) is the supported way to emit
events from a browser. The package is real — see
`sdks/web/package.json`. The handbook with the full surface is at
[SDK Handbook](../sdk/README.md); this page is the *minimum* onboarding
path.

> **Want to skip the SDK?** You can `POST /v1/events` directly with the
> `x-polaris-api-key` header (see [Phase 6](./06-first-event.md)), but you
> lose layered identity, queue management, retry/backoff, and lifecycle
> flushing. Don't.

## Install

```bash
pnpm add @polaris/web-sdk
```

The package is ESM-only (`"type": "module"`) and targets Node `>=22` for
the build toolchain. Browser runtime requirements: recent Chrome, Edge,
Firefox, Safari (best-effort for iOS/Android WebViews — see
[WebView and Mobile](../sdk/webview-and-mobile.md)).

## Minimal initialization

```ts
import { PolarisWebSdk } from "@polaris/web-sdk";

const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.PUBLIC_POLARIS_API_KEY!,
  source: { id: "your-project-web" },
});
```

`source.id` should match the `source_id` of the source you declared in
[Phase 1](./01-projects-and-sources.md). The SDK does not enforce this —
the ingester does, indirectly, through the key binding — but keeping them
in lockstep makes diagnostics trivial.

> **Use `PolarisWebSdk.create()`, not `new PolarisWebSdk(...)`.** The async
> builder probes IndexedDB and selects the strongest persistence layer; the
> synchronous constructor defaults to a memory queue and is only for tests
> and bespoke queue injection. Full reasoning is in
> [SDK / Initialization](../sdk/initialization.md).

## Identify + track

```ts
// Anonymous traffic — track() works before identify().
await sdk.track("page.viewed", {
  path: window.location.pathname,
  title: document.title,
});

// User logs in.
sdk.identify("cus_123");

// Subsequent events carry both anonymous_id and customer_id; that overlap
// is the authoritative link for the downstream identity resolver. See
// SDK / Identity for the model.
await sdk.track("checkout.started", {
  cart_id: "cart_abc",
  item_count: 3,
  subtotal_minor: 12990,
  currency: "BRL",
});

// User logs out — default reset rotates anonymous_id + session_id and
// clears customer_id (shared-device safety).
sdk.reset();

// Or: keep anonymous continuity across logout for a content site.
sdk.reset({ anonymous: false });
```

The four-method core surface (`track`, `identify`, `reset`, `flush`) is
all you need. There is no `page()` helper — page views are explicit. There
is no autocapture. See [SDK / API Reference](../sdk/api-reference.md) for
the full signatures.

## Script-tag installation (if you cannot use a bundler)

The SDK ships an inline loader snippet. Drop the snippet in `<head>` before
any code calls `polaris.track(...)`, then load the full bundle
asynchronously and drain the queue. The full ceremony is documented in
[SDK / Installation](../sdk/installation.md#script-tag-usage-inline-loader);
quoted minimum:

```html
<script>
  /* paste INLINE_LOADER_SNIPPET (exported from @polaris/web-sdk/loader) */
</script>
<script type="module">
  import { PolarisWebSdk, drainLoaderQueue } from "@polaris/web-sdk";

  const sdk = await PolarisWebSdk.create({
    endpoint: "https://ingest.polaris.internal/v1/events",
    apiKey: "PUBLIC_POLARIS_API_KEY",
    source: { id: "your-project-web" },
  });
  await drainLoaderQueue(sdk, window.polaris.q);
  window.polaris = sdk;
</script>
```

## What the SDK does and does not do

The SDK **does**:

- generate UUIDv7 `event_id`s and preserve them across retries
- persist `anonymous_id` and `session_id` across visits when storage is
  available
- batch events and flush over HTTPS to the ingester
- retry transient transport failures with exponential backoff + jitter
- expose diagnostic callbacks (`onDrop`, `onRetry`, `onFlush`, `onError`,
  `onDiagnostic`)
- enforce basic envelope/client-side validation (event-name shape,
  properties type, etc.)

The SDK **does not**:

- auto-fire `page.viewed` on navigation
- bundle the event catalog
- validate event-specific `properties` against catalog schemas — the
  ingester is authoritative
- enrich events (GeoIP, identity resolution, attribution)
- call vendor APIs
- automatically emit diagnostic events to Polaris (opt-in stream only)
- use third-party cookies or fingerprinting

Full architectural rationale: [SDK Standards](../architecture/10-sdk-standards.md).

## Wire diagnostics for production

```ts
const sdk = await PolarisWebSdk.create({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.PUBLIC_POLARIS_API_KEY!,
  source: { id: "your-project-web" },
  diagnostics: {
    onError: (err) => console.error("polaris error", err),
    onDrop: (entry, reason) =>
      console.warn("polaris drop", reason, entry.payload.event),
    onRetry: (entry, attempt, err) =>
      console.debug("polaris retry", attempt, err?.message),
  },
});
```

You almost certainly want at least `onError` and `onDrop` wired in
production. They are the only reliable signal that the SDK is *not*
delivering, since `track()` does not throw on transport failure.

## Done when

- `pnpm add @polaris/web-sdk` succeeded.
- `PolarisWebSdk.create({...})` runs at app boot without throwing.
- `await sdk.track("page.viewed", {...})` resolves with an `event_id`.

Verifying that the event actually *reaches* the ingester is
[Phase 6](./06-first-event.md).

## Next

If you also have a backend surface, [Phase 5 — Install the Node SDK](./05-install-node-sdk.md).
Otherwise, jump to [Phase 6 — Send your first event and verify ingestion](./06-first-event.md).
