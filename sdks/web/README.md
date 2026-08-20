# `@polaris/web-sdk`

Polaris Web SDK — thin transport and identity helpers for browser producers.

The Web SDK is offline-first and lifecycle-aware. It picks the strongest available identity layer (first-party cookie -> localStorage -> sessionStorage -> memory) and queue layer (IndexedDB -> localStorage -> memory) at construction. No third-party cookies, no fingerprinting. The ingester remains the authoritative validator; the SDK does not enrich, attribute, or own schema governance.

For the full handbook, see [`docs/sdk/`](../../docs/sdk/README.md). Topics include installation, initialization, the public API, identity, queue and flush behaviour, retries, diagnostics, WebView caveats, and troubleshooting.

## Quickstart

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

Page views are explicit: the SDK does **not** auto-fire `page.viewed` on navigation. See [`docs/sdk/explicit-events.md`](../../docs/sdk/explicit-events.md).

## See also

- [`docs/sdk/`](../../docs/sdk/README.md) — full SDK handbook
- [`docs/architecture/10-sdk-standards.md`](../../docs/architecture/10-sdk-standards.md) — architectural rules
- [`docs/architecture/04-ingestion-and-sdks.md`](../../docs/architecture/04-ingestion-and-sdks.md) — ingester contract
- [`docs/architecture/01-event-contract.md`](../../docs/architecture/01-event-contract.md) — canonical envelope
