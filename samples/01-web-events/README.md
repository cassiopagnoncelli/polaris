# 01 — Browser events, straight to the ingester

The plain browser integration: one `@polaris/web-sdk` instance in the page,
posting batches to `POST /v1/events` with a publishable web key.

```text
browser (web key) ──HTTPS──▶ ingester ──▶ raw.events
```

## Run it

Finish the [one-time setup](../README.md#one-time-setup) first — including
step 5, the origin allow-list row, which this sample needs and the other two
do not.

```bash
pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local   # paste the web key
pnpm dev
```

Open <http://localhost:3000>. The activity panel on the home page is fed by
the SDK's diagnostic callbacks, so you can watch queueing, flushing, and
rejection happen.

## The four files that matter

| File                        | What it shows                                                            |
| --------------------------- | ------------------------------------------------------------------------ |
| `lib/polaris.ts`            | one instance per tab, created once and awaited by everyone else          |
| `app/polaris-provider.tsx`  | the instance in React context, and explicit `page.viewed` on navigation  |
| `app/demo-panel.tsx`        | `identify` / `reset` / `flush`, and what the diagnostic callbacks report |
| `app/checkout/checkout-button.tsx` | a catalog event, plus the same event rejected on purpose          |

## Three things that surprise people

**There is no auto page tracking.** `page.viewed` is a catalog event with a
versioned schema, like any other. `PageViewTracker` fires it on pathname or
query changes; a modal-heavy app or an infinite feed would define "a page
view" differently, which is exactly why the SDK does not decide for you.

**`schema_version` defaults to 1.** `page.viewed` v1 and v2 are different
shapes — v2 splits `search` out of `path` and adds `referrer` — so the
tracker passes `{ schemaVersion: 2 }`. Sending v2 properties under v1 is a
rejection, not a warning.

**Page-exit flushes need an override here.** The SDK prefers
`navigator.sendBeacon` for the `pagehide` flush, and beacons cannot set
request headers — the batch would arrive without `x-polaris-api-key` and be
refused with 401. `lib/polaris.ts` passes `sendBeacon: () => false` to force
the `fetch(..., { keepalive: true })` path, which does carry the header.
Sample 03 has no such problem: its relay authenticates server-side.

## The key in the bundle

`NEXT_PUBLIC_POLARIS_API_KEY` is inlined into the JavaScript that ships to
the browser. That is what a *web* key is for, and it is why the ingester
defends it with an origin allow-list and per-key rate limits rather than
with secrecy. A key issued `--type backend` must never appear here.

If shipping any key is unacceptable to your security review, use
[sample 03](../03-proxy-ingest) instead.

## Left to you

- consent gating — Polaris carries `consent` metadata on the envelope but
  enforces nothing in v1
- deciding what a page view means in your app
- forwarding the diagnostic callbacks to your own logging or metrics
- a real origin allow-list per environment, not just `http://localhost:3000`
