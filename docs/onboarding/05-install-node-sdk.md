# Phase 5 — Install the Node SDK

The Polaris Node SDK (`@polaris/node-sdk`) is the supported way to emit
events from backend services. The package is real — see
`sdks/node/package.json`. The handbook with the full surface is at
[SDK Handbook](../sdk/README.md); this page is the *minimum* onboarding
path.

## Install

```bash
pnpm add @polaris/node-sdk
```

ESM-only (`"type": "module"`), targets Node `>=22`. For services that
already run Active LTS Node with ESM, no extra configuration is needed.

## Minimal initialization

```ts
import { PolarisNodeSdk } from "@polaris/node-sdk";

const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "your-project-api" },
});
```

Note: `source.type` is required on the Node SDK (Web defaults `type` to
`browser`). Set it to whatever matches your source declaration —
`backend`, `webhook`, or `job`.

## Identify + track

The Node SDK does not maintain persistent identity. The caller supplies
identity per call (or sets it on the SDK instance for the session):

```ts
// Set a default customer_id on the SDK instance.
polaris.identify("cus_123");

await polaris.track("payment.approved", {
  payment_id: "pay_123",
  order_id: "ord_456",
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
  psp: "stripe",
});

// Or override identity per event (rare).
await polaris.track(
  "payment.approved",
  { amount: 12990, currency: "BRL" },
  { identity: { customer_id: "cus_123" } },
);

// Critical: flush before shutdown.
await polaris.flush();
await polaris.close();
```

See [SDK / API Reference](../sdk/api-reference.md) and [SDK / Identity](../sdk/identity.md)
for the full signatures.

## Shutdown lifecycle

This is the most common Node SDK mistake. The default in-memory queue does
not survive a process crash; if you exit without `flush()` + `close()`, the
queue is lost.

```ts
// Graceful shutdown in your service:
process.on("SIGTERM", async () => {
  await polaris.flush();          // best-effort drain
  await polaris.close();          // bounded drain + cleanup
  server.close();
  process.exit(0);
});
```

`close()` is idempotent. Subsequent `track`/`identify`/`reset` calls throw.
The drain is bounded by `shutdownTimeoutMs` (default 5s); after that,
remaining events are dropped with reason `shutdown_timeout`. See [SDK /
Queue and Flush](../sdk/queue-and-flush.md).

If your service uses one of the standard process-signal patterns, opt into
the SDK's built-in shutdown hook:

```ts
const polaris = new PolarisNodeSdk({
  endpoint: "...",
  apiKey: "...",
  source: { type: "backend", id: "your-project-api" },
  autoFlushOnShutdown: true, // registers SIGTERM/SIGINT handlers
});
```

## For "must not lose this event" producers

The default Node SDK queue is bounded in-memory. **Do not rely on it for
events that must survive a crash.** Two options:

1. Use a durable queue adapter (Redis / filesystem / custom — see [SDK /
   Queue and Flush](../sdk/queue-and-flush.md) and the Node SDK source).
2. Emit from your own application outbox: write the event to your DB in
   the same transaction as the business write, then have a worker call
   `polaris.track()` from the outbox.

The SDK is a wire transport. It is not a durability layer. See [SDK
Standards / Node SDK](../architecture/10-sdk-standards.md#node-sdk).

## Wire diagnostics for production

```ts
const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "your-project-api" },
  diagnostics: {
    onError: (err) => log.error({ err }, "polaris error"),
    onDrop: (entry, reason) => log.warn({ reason, event: entry.payload.event }, "polaris drop"),
    onFlush: (result) => log.debug(result, "polaris flush"),
  },
});
```

Same logic as the Web SDK: `track()` does not throw on transport failure.
The only reliable signal that you are *not* delivering is the diagnostic
stream.

## Done when

- `pnpm add @polaris/node-sdk` succeeded.
- `new PolarisNodeSdk({...})` runs at process boot without throwing.
- `await polaris.track("...", {...})` resolves with an `event_id`.
- Your shutdown path calls `flush()` then `close()`.

Verifying that the event actually *reaches* the ingester is
[Phase 6](./06-first-event.md).

## Next

[Phase 6 — Send your first event and verify ingestion](./06-first-event.md).
