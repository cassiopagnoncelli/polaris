# Explicit `page.viewed`

Polaris SDKs do **not** auto-fire `page.viewed` on navigation.

This is a deliberate architectural choice, captured in [SDK Standards / Core Public API](../architecture/10-sdk-standards.md#core-public-api):

> No automatic page tracking is enabled by default. Page views should be explicit.

Reasons:

- Automatic page tracking guesses at what counts as a "page view" — SPA route changes? Hash changes? Modal opens? — and the wrong guess pollutes the catalog with events that do not match the producer's intent.
- The SDK has no view into your routing semantics. A correct `page.viewed` event includes properties the SDK cannot infer: route name, page section, search facets, A/B variant, content ID.
- Polaris's SDK contract is "transport + identity helper, not analytics engine." Synthesising events from DOM heuristics belongs upstream, not in the wire layer.

## How to fire `page.viewed`

You fire it. Call `track("page.viewed", { ... })` at the moment in your application code where a page view truly happens.

### Static site / multi-page app

```ts
// In your shared site bootstrap.
await sdk.track(
  "page.viewed",
  {
    path: window.location.pathname,
    search: window.location.search || null,
    title: document.title,
    referrer: document.referrer || null,
  },
  { schemaVersion: 2 },
);
```

### SPA (React Router, Vue Router, etc.)

Hook into your router's navigation event:

```ts
router.afterEach((to) => {
  void sdk.track(
    "page.viewed",
    {
      // v2 keeps the query out of `path`; your router exposes them apart.
      path: to.path,
      search: window.location.search || null,
      title: document.title,
      referrer: document.referrer || null,
    },
    { schemaVersion: 2 },
  );
});
```

### Backend-rendered page

For a Node service that renders pages, the Web SDK fires `page.viewed` from the client when the page loads. The Node SDK does not fire `page.viewed` — that is a browser fact, not a backend fact. Backend services should track domain events (`order.placed`, `subscription.renewed`) rather than view events.

## Property conventions

`page.viewed` is a regular catalog event. Like any other event, the property shape is owner-defined per [Event Contract / Property-level style is owner-defined](../architecture/01-event-contract.md#property-level-style-is-owner-defined). Common properties:

| Property | Notes |
| --- | --- |
| `path` | Pathname including leading slash, no host. |
| `url` | Absolute URL including query. Optional. |
| `title` | `document.title`. |
| `referrer` | `document.referrer`, or `null` when empty. |
| `route` | The router's named route, if you have one. |

Define the schema in `definitions/events/page/viewed.<version>.ts` and validate against it through the standard catalog flow.

## What about UTM/campaign?

Campaign parameters travel in `context.campaign`, not in `properties`. Your application reads them from the URL once at load and supplies them via the SDK's `defaultContext` or the per-event `context` override:

```ts
const url = new URL(window.location.href);
await sdk.track("page.viewed", {
  path: url.pathname,
  search: url.search || null,
  title: document.title,
  referrer: document.referrer || null,
}, {
  schemaVersion: 2,
  context: {
    campaign: {
      source: url.searchParams.get("utm_source"),
      medium: url.searchParams.get("utm_medium"),
      campaign: url.searchParams.get("utm_campaign"),
    },
  },
});
```

Campaign or click-ID changes do **not** rotate the session. That is captured in event context; attribution is interpreted downstream. See [Identity / Session Lifecycle](../architecture/10-sdk-standards.md#session-lifecycle).

## What if I want auto page tracking anyway?

You can wire it yourself in a few lines:

```ts
let lastPath = window.location.pathname;
const fire = () => {
  void sdk.track(
    "page.viewed",
    {
      path: window.location.pathname,
      search: window.location.search || null,
      title: document.title,
      referrer: document.referrer || null,
    },
    { schemaVersion: 2 },
  );
};

// Fire on first load.
fire();

// Fire on SPA history events.
window.addEventListener("popstate", () => {
  if (window.location.pathname !== lastPath) {
    lastPath = window.location.pathname;
    fire();
  }
});
```

But the SDK will not do this for you. If you build this pattern, own it in your app code; do not ask the SDK to add an `autoTrackPageViews` option. See [SDK Standards / Core Public API](../architecture/10-sdk-standards.md#core-public-api).
