# 01 — Storefront

One Next.js app producing events from every surface Polaris supports, against
one project, one catalog, and one visitor.

```text
                    ┌── direct ──HTTPS──────────────────────▶ ingester ──▶ raw.events
browser (web sdk) ──┤                                             ▲
                    └── relay ───▶ /api/polaris/events ───────────┤
                                    (web key, server-side)        │
server (node sdk) ─────────────────────────────────────────────---┘
                    (backend key, identity read from the cookie)
```

The three paths are not three demos sitting next to each other. They share a
visitor: the browser writes `anonymous_id` into a first-party `polaris_id`
cookie, the server reads that cookie and hands the same id to its own events,
and both arrive already joined. That is the thing worth copying, and it is
the thing three separate apps could not show.

## Run it

Finish the [one-time setup](../README.md#one-time-setup) first — `make setup`
seeds the origin allow-list entry the `direct` transport needs, and issues the
two keys this app sends with.

```bash
pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local
```

No keys to paste: this app produces from two sources, and `make setup` issued
one for each into `blueprints/api-key`. `next.config.ts` reads them from there
for anything `.env.local` leaves empty. To reissue by hand:

```bash
make api_key                                           # web  -> storefront-web
make api_key KEY_SOURCE=payments-api KEY_TYPE=backend  # backend -> payments-api
```

```bash
pnpm dev
```

Open <http://localhost:3641>. Nothing crashes on a half-finished setup: an
unconfigured path reports itself in the activity drawer and disables its
buttons, so you can fill keys in one at a time.

## The pages

Three of them are for pressing buttons; the fourth is for reading. Nothing is
explained twice.

| Page         | Shows                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| `/`          | identity, `track()` accepted and refused four ways, and `identify` / `reset` / `flush` |
| `/checkout`  | the same `checkout.started` from three producers, and whether they stitched       |
| `/transport` | direct vs relay, switchable in place                                              |
| `/learn`     | every explanation, in one readable page, anchored per topic                       |

## The activity drawer

Pinned to the bottom of every page, collapsible, exactly 40% of the viewport
when open. It carries three kinds of line, and the difference between them is
the point:

| Tag      | Means                                                                          |
| -------- | ------------------------------------------------------------------------------ |
| `ui`     | this page did something — a click, a route change. No event was produced.       |
| `web`    | the Web SDK's diagnostic callbacks, verbatim: `onDiagnostic`, `onFlush`, `onDrop`, `onError` |
| `server` | what a Server Action or route handler reported back                             |

Every control reports twice — once as `ui` for the interaction, once as `web`
for whatever the SDK made of it. The gap between the two lines is where a
`track()` call would have to go in your own app, because nothing in the SDK
puts it there for you.

## The files that matter

| File                                | What it shows                                                        |
| ----------------------------------- | -------------------------------------------------------------------- |
| `lib/polaris-web.ts`                | one Web SDK per tab, and what swapping its transport actually costs  |
| `lib/polaris-node.ts`               | one Node SDK per process, and the cookie read that makes the stitch  |
| `lib/transport-mode.ts`             | the direct/relay choice, in one place                                |
| `app/polaris-provider.tsx`          | the SDK in React context, and explicit `page.viewed` on navigation   |
| `app/event-panel.tsx`               | `track()` accepted twice and refused twice, against the same catalog |
| `app/activity-drawer.tsx`           | the bottom drawer, and what the diagnostic callbacks are wired to     |
| `app/learn/page.tsx`                | the explanations the other pages link to instead of repeating        |
| `app/checkout/browser-checkout.tsx` | a catalog event, plus the same event rejected on purpose             |
| `app/checkout/actions.ts`           | the same event from a Server Action, with the browser's identity     |
| `app/api/checkout/route.ts`         | the same event from a route handler, plus server-decided context     |
| `app/api/polaris/events/route.ts`   | the relay: attach the key server-side, pass the answer back untouched |

## Things that surprise people

**There is no auto page tracking.** `page.viewed` is a catalog event with a
versioned schema, like any other. `PageViewTracker` fires it on pathname or
query changes; a modal-heavy app or an infinite feed would define "a page
view" differently, which is exactly why the SDK does not decide for you.

**`schema_version` defaults to 1.** `page.viewed` v1 and v2 are different
shapes — v2 splits `search` out of `path` and adds `referrer` — so the
tracker passes `{ schemaVersion: 2 }`. Sending v2 properties under v1 is a
rejection, not a warning.

**Page-exit flushes need an override in direct mode.** The SDK prefers
`navigator.sendBeacon` for the `pagehide` flush, and beacons cannot set
request headers — the batch would arrive without `x-polaris-api-key` and be
refused 401. `lib/polaris-web.ts` passes `sendBeacon: () => false` for the
direct path only. The relay authenticates server-side, so it keeps beacons.

**Two keys, not one.** The web key is publishable and origin-scoped; the
backend key is a secret and is neither. They are also different catalog
sources — `storefront-web` and `payments-api` — which is what lets a query
separate what the browser claimed from what the server confirmed.

**Switching transport drops whatever is still queued.** The swap closes the
old SDK, which flushes best-effort and then tears down its queue. That is the
honest cost of changing transports mid-session, and the reason a real app
picks one at build time and deletes the other.

## Left to you

- consent gating — Polaris carries `consent` metadata on the envelope but
  enforces nothing in v1
- deciding what a page view means in your app
- forwarding the diagnostic callbacks to your own logging or metrics
- rate limiting the relay route, if you keep it — it is an unauthenticated
  write path into your key
- a real origin allow-list per environment, if you keep the direct path
- picking one transport and deleting the other, along with the switch
