# `@polaris/node-sdk`

Polaris Node SDK — thin transport and identity helpers for backend producers.

The Node SDK is queue-first: every `track()` assigns a UUIDv7 `event_id` and enqueues before any transport attempt. Default queue is bounded in-memory; the `QueueAdapter` interface lets you plug in durable backends. Explicit `flush()` and `close()` lifecycle. No process signal handlers by default; `autoFlushOnShutdown` is opt-in. The ingester remains the authoritative validator; the SDK does not enrich, attribute, or own schema governance.

For the full handbook, see [`docs/sdk/`](../../docs/sdk/README.md). Topics include installation, initialization, the public API, identity, queue and flush behaviour, retries, diagnostics, queue adapter guidance, shutdown, and troubleshooting.

## Quickstart

```ts
import { PolarisNodeSdk } from "@polaris/node-sdk";

const polaris = new PolarisNodeSdk({
  endpoint: "https://ingest.polaris.internal/v1/events",
  apiKey: process.env.POLARIS_API_KEY!,
  source: { type: "backend", id: "checkout-api" },
});

await polaris.track("payment.approved", {
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
});

await polaris.flush();
await polaris.close();
```

The default in-memory queue does **not** survive process crashes. Critical backend producers should either inject a durable `QueueAdapter` implementation or emit events from their own reliable outbox. See [`docs/sdk/queue-and-flush.md`](../../docs/sdk/queue-and-flush.md).

## See also

- [`docs/sdk/`](../../docs/sdk/README.md) — full SDK handbook
- [`docs/architecture/10-sdk-standards.md`](../../docs/architecture/10-sdk-standards.md) — architectural rules
- [`docs/architecture/04-ingestion-and-sdks.md`](../../docs/architecture/04-ingestion-and-sdks.md) — ingester contract
- [`docs/architecture/01-event-contract.md`](../../docs/architecture/01-event-contract.md) — canonical envelope
