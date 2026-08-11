# 02 — Backend events from Next.js

`@polaris/node-sdk` inside a Next server: one instance per process, used
from both a Route Handler and a Server Action. The API key never leaves the
server.

```text
browser ──▶ your Next server (backend key) ──HTTPS──▶ ingester ──▶ raw.events
```

## Run it

Finish the [one-time setup](../README.md#one-time-setup) first. This sample
needs no origin allow-list row — server-to-server calls send no `Origin`
header, so the CORS guard never runs.

```bash
pnpm install --ignore-workspace
```

```bash
cp .env.example .env.local   # paste the backend key
pnpm dev
```

Open <http://localhost:3001> and press either button. The dev-server
terminal prints what each flush delivered.

## The four files that matter

| File                       | What it shows                                                         |
| -------------------------- | --------------------------------------------------------------------- |
| `lib/polaris.ts`           | one SDK per process, cached on `globalThis` so hot reload cannot leak one |
| `app/api/checkout/route.ts`| track → flush → respond, with server-stamped `context`                |
| `app/actions.ts`           | the same thing from a Server Action                                   |
| `instrumentation.ts`       | constructing the SDK before the first request                         |

## The lifecycle, which is the whole point

**`track()` only queues.** It returns the `event_id` as soon as the event is
in memory — no network. That is what keeps it off your checkout's critical
path.

**Flush before you respond.** A long-running server would deliver on the 5
second interval eventually. A serverless runtime freezes the moment the
response is sent, so anything still queued arrives late, or never:

```ts
await polaris.track("checkout.started", properties);
await polaris.flush();
return NextResponse.json({ ok: true });
```

**Close on shutdown.** `autoFlushOnShutdown: true` installs SIGTERM/SIGINT
handlers that drain within `shutdownTimeoutMs`. It is opt-in because a
library should not install signal handlers behind your back.

**The default queue is in-memory.** A crashed process loses whatever it
held. For events you genuinely cannot lose, write your own outbox row in the
same transaction as the business change and emit from that — the
`QueueAdapter` interface exists for exactly this.

## Stitching browser and backend events

Backend events carry whatever identity you give them; the Node SDK infers
nothing. When the same visitor also runs the Web SDK, its first-party
`polaris_id` cookie is the join key — `identityFromCookies()` in
`lib/polaris.ts` reads it so a browser `page.viewed` and a server
`checkout.started` share one `anonymous_id` and `session_id`.

A backend with no browser in front of it (webhook, cron, queue worker) skips
this entirely and passes its own identifiers, or none.

## Left to you

- a durable queue adapter, or an outbox, if losing events on crash matters
- deciding which identity your server trusts: the cookie is a hint, the
  session you authenticated is a fact
- not putting a backend key anywhere a `NEXT_PUBLIC_` variable can reach
