# WebView and Mobile

The Web SDK supports WebViews and in-app browsers as **best-effort**. They are important but not a hard reliability guarantee. The architectural treatment is in [SDK Standards / Browser Support](../architecture/10-sdk-standards.md#browser-support); this page is the operator's caveats.

## Explicit browser-support tiers

### Fully supported

- Recent Chrome (desktop and Android)
- Recent Edge
- Recent Firefox
- Recent Safari (desktop and iOS)

These hit the layered identity (cookie + localStorage + sessionStorage + memory) and the layered queue (IndexedDB + localStorage + memory) without surprises.

### Important but degraded / best-effort

- iOS WebViews (in-app `WKWebView`)
- Android WebViews (`android.webkit.WebView`)
- In-app browsers (Instagram, Facebook, TikTok)
- Ad embedded browsers

In these environments expect any of:

- isolated cookies (the host app's cookie jar is not shared with the system browser)
- evicted localStorage (some WebViews aggressively clear on app suspend)
- non-persistent IndexedDB
- no persistent storage at all (memory-only fallback)

## What changes inside a WebView

### Cookies behave differently

A first-party cookie set inside an Instagram in-app browser does **not** transfer when the user later opens the same site in Safari. Each host process has its own cookie jar.

The SDK's `getCapability()` returns `{ webview: true, primary: ..., degraded: true }` in most of these cases, so you can detect and log the situation:

```ts
const capability = sdk.getCapability();
if (capability.webview) {
  log.info({ primary: capability.primary, degraded: capability.degraded }, "running in webview");
}
```

### Storage may be transient

If the SDK lands on `sessionStorage` or `memory`, `anonymous_id` does not survive a navigation away from the page. The `degraded` flag in `getCapability()` is `true` in these cases.

For session-only continuity, this is fine. For cross-visit identity, you have to fall back to:

- backend events that carry the customer ID (the most reliable path)
- campaign/click IDs in URLs (preserved when the user navigates back into your site through a tracked link)

### Click-through identity matters more

Because storage may not persist, **capture campaign/click IDs every visit**. The user is likely arriving via a tracked link, and the click ID in the URL is the only continuity signal you can rely on.

```ts
const url = new URL(window.location.href);
await sdk.track("page.viewed", {
  path: url.pathname,
}, {
  context: {
    campaign: {
      source: url.searchParams.get("utm_source"),
      medium: url.searchParams.get("utm_medium"),
      campaign: url.searchParams.get("utm_campaign"),
      content: url.searchParams.get("utm_content"),
      term: url.searchParams.get("utm_term"),
    },
  },
});
```

Click IDs (gclid, fbclid, ttclid, msclkid) flow through the same `context.campaign` slot if your event schema permits, or as properties on the event.

The downstream identity resolver weights campaign/click context heavily when storage-backed continuity is missing — see [Identity Resolution Coupling](../architecture/10-sdk-standards.md#identity-resolution-coupling).

## Detecting WebViews

The SDK's `getCapability().webview` flag is heuristic. It checks the user-agent for known WebView signatures (`wv` token, in-app browser markers). It is **not** authoritative — some embedded browsers spoof a regular user-agent.

For your own application logic, use the flag as a signal, not a contract:

```ts
const capability = sdk.getCapability();
if (capability.webview || capability.degraded) {
  // Adapt UI / fallback paths.
}
```

## Operator advice

### 1. Capture URL context aggressively

If your traffic includes ad campaigns or paid-search funnels, the URL is the most stable continuity signal in a WebView. Wire campaign/click ID extraction into your `page.viewed` flow.

### 2. Treat WebView events as weaker continuity signal downstream

The architecture doc is explicit: WebView storage layers are an *evidence quality* signal, not authoritative identity. Downstream identity resolution should treat WebView-flagged events accordingly. As an SDK operator, you do not need to do anything special here — just make sure your `getCapability()` snapshot is logged so the operations team can correlate.

### 3. Test on real devices, not just on emulators

Emulators and headless browsers do not reproduce the storage quirks of real WebViews:

- iOS Safari's Intelligent Tracking Prevention has different rules in private mode and in non-Safari embedded browsers.
- Android Chrome's storage permissions depend on the host app's manifest.
- Some Asian super-apps (WeChat, LINE, KakaoTalk) have their own custom WebView builds with idiosyncratic storage policies.

A test pass should cover at least: stock iOS Safari, iOS WebView (Instagram, Facebook), stock Android Chrome, Android WebView (Instagram, Facebook), and one private-mode session.

### 4. Use file-backed storage where the host supports it

The Web SDK does **not** ship a file-backed identity layer; the layered store is the four browser layers (cookie / localStorage / sessionStorage / memory). For the *Node* SDK, file-backed identity is on the roadmap but not built today. For the *Web* SDK, the only persistence options are the four browser layers; the host application would need to expose a native bridge if file-backed persistence were ever needed inside a custom WebView, and that is a host-side concern.

### 5. Do not try to compensate with fingerprinting

Fingerprinting is forbidden by [SDK Standards / Layered Browser Persistence](../architecture/10-sdk-standards.md#layered-browser-persistence). The right answer to "storage might not persist" is to capture campaign/click context, not to invent stable IDs from browser features.

## Backend producers in mobile contexts

If you are sending events from a backend that *serves* mobile users (a payments API, a subscription service), use the **Node SDK** on the backend rather than trying to make a WebView SDK reliable. Backend events carry the customer ID authoritatively; they do not depend on browser storage.

The Web SDK + Node SDK combination is the recommended pattern for mobile-heavy traffic:

- Web SDK fires session/page events from the browser (best-effort, weighted accordingly)
- Node SDK fires authoritative business events (`payment.approved`, `subscription.renewed`) from the backend

Downstream identity resolution joins the two on shared identifiers.

## Summary

| Environment | Identity persistence | Queue persistence | Diagnostic flag |
| --- | --- | --- | --- |
| Modern desktop browser | cookie + localStorage | IndexedDB | not degraded |
| Modern mobile browser | cookie + localStorage | IndexedDB or localStorage | not degraded |
| Private mode | sessionStorage or memory | memory | `degraded: true` |
| iOS WebView | varies; often degraded | IndexedDB or memory | `webview: true` |
| Android WebView | varies; often degraded | IndexedDB or memory | `webview: true` |
| Ad in-app browser | usually degraded | memory | `webview: true`, `degraded: true` |
