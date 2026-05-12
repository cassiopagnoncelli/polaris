# Installation

Both SDKs are workspace packages distributed inside the Polaris monorepo today. Once published to the internal registry, the installation surface looks the same as any other internal package.

## Web SDK

### As an ESM package

Install:

```bash
pnpm add @polaris/web-sdk
```

Import:

```ts
import { PolarisWebSdk } from "@polaris/web-sdk";
```

The package is ESM-only (`"type": "module"`). If you bundle for an older runtime, run the SDK through your existing transpilation pipeline; do not ask the SDK to ship CommonJS.

The package targets Node `>=22` for the build/test toolchain. The browser runtime requirement is modern evergreen browsers (recent Chrome, Edge, Firefox, Safari) with best-effort support for iOS/Android WebViews and in-app browsers — see [WebView and Mobile](./webview-and-mobile.md).

### Subpath exports

The Web SDK exposes a few subpaths for callers that want to wire components individually:

```ts
import { CookieStore, LayeredIdentityStore } from "@polaris/web-sdk/identity";
import { IndexedDbQueue, MemoryQueue } from "@polaris/web-sdk/queue";
import { HttpsTransport } from "@polaris/web-sdk/transport";
import { INLINE_LOADER_SNIPPET, drainLoaderQueue } from "@polaris/web-sdk/loader";
```

Most applications should stick to the top-level `@polaris/web-sdk` import.

### Script-tag usage (inline loader)

The Web SDK ships an async loader snippet for sites that prefer dropping a `<script>` tag into the page. The snippet defines a temporary global `polaris` with stub `track`, `identify`, `reset`, and `flush` methods that buffer calls into a queue. When the full SDK bundle loads, it drains the queue into the live SDK instance.

The exported snippet text is `INLINE_LOADER_SNIPPET` from `@polaris/web-sdk/loader`:

```ts
import { INLINE_LOADER_SNIPPET } from "@polaris/web-sdk/loader";

console.log(INLINE_LOADER_SNIPPET);
// (function(w){
//   if (w.polaris && w.polaris.q) return;
//   var q = [];
//   var stub = function(method){ return function(){
//     q.push([method].concat(Array.prototype.slice.call(arguments)));
//   };};
//   w.polaris = {
//     q: q,
//     track: stub("track"),
//     identify: stub("identify"),
//     reset: stub("reset"),
//     flush: stub("flush")
//   };
// })(window);
```

Drop the snippet into `<head>` before any code that calls `polaris.track(...)`, then load the full SDK bundle asynchronously. After the bundle initialises, call `drainLoaderQueue` to replay the buffered calls in order:

```html
<script>
  /* paste INLINE_LOADER_SNIPPET here */
</script>
<script type="module">
  import { PolarisWebSdk, drainLoaderQueue, type LoaderQueue } from "@polaris/web-sdk";

  const sdk = await PolarisWebSdk.create({
    endpoint: "https://ingest.polaris.internal/v1/events",
    apiKey: "POLARIS_API_KEY",
    source: { id: "marketing-site" },
  });

  const pending = (window as unknown as { polaris: { q: LoaderQueue } }).polaris.q;
  await drainLoaderQueue(sdk, pending);

  // Optional: swap the loader stub for the real SDK so subsequent
  // synchronous callers go straight to the live instance.
  (window as unknown as { polaris: PolarisWebSdk }).polaris = sdk;
</script>
```

The loader supports `track`, `identify`, `reset`, and `flush`. Unknown commands are skipped — the snippet is forward-compatible so a future SDK method does not break an older snippet that callers may have inlined into their HTML.

A self-contained IIFE/UMD bundle that wraps the snippet and the SDK script automatically is a future task. Today, the recommended path is the ESM package above; the loader snippet is the bridge for sites that genuinely cannot wait on a module-loader path.

## Node SDK

### Install

```bash
pnpm add @polaris/node-sdk
```

### Import

```ts
import { PolarisNodeSdk } from "@polaris/node-sdk";
```

The Node SDK is ESM-only and targets Node `>=22`. For backend services that already run on the Active LTS Node and use ESM, no additional configuration is required.

### Subpath exports

```ts
import { MemoryQueueAdapter } from "@polaris/node-sdk/queue";
import { HttpsTransport } from "@polaris/node-sdk/transport";
```

The default in-memory queue and HTTPS transport are wired automatically by the `PolarisNodeSdk` constructor; you only need these subpaths if you are injecting a custom queue adapter or transport.

## What gets bundled

The SDKs are intentionally small:

- no event catalog (the ingester is authoritative)
- no vendor SDKs
- no fingerprinting libraries
- no heavy polyfills

The only runtime dependencies are `@polaris/shared-schemas` (envelope types) and `uuid` (UUIDv7). Do not introduce vendor SDKs or analytics-engine helpers into the SDK packages — that is what processors and destination consumers are for.

## Next

- [Initialization](./initialization.md) — configuration options for both SDKs.
- [API Reference](./api-reference.md) — the four public methods.
