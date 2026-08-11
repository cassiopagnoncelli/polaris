# 03 — Browser events through your own origin

The same Web SDK as [sample 01](../01-web-events), pointed at a route in this
app instead of at the ingester. The route attaches the API key and forwards
the batch.

```text
browser ──▶ /api/polaris/events (web key added here) ──▶ ingester ──▶ raw.events
```

## Run it

Finish the [one-time setup](../README.md#one-time-setup) first. No origin
allow-list row is needed: the relay is server-to-server, so the ingester
sees no `Origin` header and the CORS guard never runs.

```bash
pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local   # paste the web key — no NEXT_PUBLIC_ prefix
pnpm dev
```

Open <http://localhost:3002> with the Network tab visible. Every request
goes to this origin; nothing addresses the ingester from the browser.

## The two files that matter

| File                                | What it shows                                                     |
| ----------------------------------- | ----------------------------------------------------------------- |
| `lib/polaris.ts`                    | the SDK pointed at a relative endpoint, with a placeholder key    |
| `app/api/polaris/events/route.ts`   | the relay: authenticate, stamp context, forward, pass the answer back |

## What the relay must get right

**Return the ingester's response unchanged.** Polaris answers per event —
accepted here, `schema_validation_failed` there. The SDK reads that answer to
decide what to retry, what to drop as permanently rejected, and what to
count as delivered. Collapsing it into `{ ok: true }` blinds the SDK's retry
logic.

**Read the body as text.** A page-exit `sendBeacon` can arrive with a
`text/plain` content type carrying JSON. `request.json()` is stricter than
you want here.

**Stamp `context.ip` and `context.user_agent` server-side.** The connection
knows these; the client only claims them. Behind a proxy, read the header
your own edge writes — `x-forwarded-for` is forgeable by whoever reaches
your server first.

**Bound the batch.** The Web SDK batches at 20. The route caps at 50 and
rejects anything larger, because it is now an unauthenticated write path
into a real API key.

## Trade-offs against sample 01

Better here: no key in the bundle, no allow-list row per environment, no
CORS preflight, a first-party request path, and page-exit beacons work
normally — the beacon cannot carry an auth header, but this relay does not
need it to.

Worse here: your app servers now carry event traffic and its cost, the
platform's origin allow-list and per-key rate limits no longer defend the
key, and you own the abuse controls that replace them.

## Left to you

- rate limiting on the relay, per IP and per session
- a body size cap at your edge, above the batch count cap in the route
- not logging request bodies: every event that passes through carries
  identifiers
- consent gating, same as sample 01
