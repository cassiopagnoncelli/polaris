# Phase 6 — Send your first event and verify ingestion

You have a project, a source, API keys, a registered event schema, and a
producer with the SDK initialized. Now you push the first event and verify
it landed.

## The ingestion endpoint

Polaris exposes exactly one HTTP service in v1: the **ingester**. The full
contract is in [`docs/api/`](../api/README.md) — the OpenAPI document is
authoritative (`docs/api/openapi.yaml` / `docs/api/openapi.json`).

The one path you call:

```text
POST /v1/events
Header: x-polaris-api-key: <api_key_id>.<secret>
Body:   { "events": [ <ProducerEnvelope>, ... ] }
```

`x-polaris-api-key` is the only auth header. The SDK sets it for you. If
you call the endpoint directly with `curl`, you set it yourself.

## Option A — Send from your SDK

If [Phase 4](./04-install-web-sdk.md) or [Phase 5](./05-install-node-sdk.md)
is done, you already have the call:

```ts
await sdk.track("checkout.started", {
  cart_id: "cart_abc",
  item_count: 3,
  subtotal_minor: 12990,
  currency: "BRL",
});
```

The promise resolves with the `event_id`. The SDK enqueues, batches, and
flushes to `/v1/events` according to its lifecycle (eager flush for the
first 15s, then steady 5s batch on Web; interval + manual on Node).

## Option B — Send with `curl`

For one-off verification or non-SDK producers (operator scripts, webhook
relays you haven't wrapped yet), call the ingester directly. The envelope
must match the [canonical schema](../architecture/01-event-contract.md#canonical-envelope).
The ingester *stamps* `project_id`, `environment`, and trusted source
metadata from the API key — do not send those fields.

```bash
curl -sS -X POST https://ingest.polaris.internal/v1/events \
  -H "content-type: application/json" \
  -H "x-polaris-api-key: polaris_ak_018f1b9e-7b50-7b12-9a2e-0e2f88d8f551.<secret>" \
  -d '{
    "events": [
      {
        "event_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
        "event": "checkout.started",
        "schema_version": 1,
        "occurred_at": "2026-05-15T12:00:00.000Z",
        "source": { "type": "backend", "id": "your-project-api", "sdk": "curl", "sdk_version": "0" },
        "identity": { "anonymous_id": null, "session_id": null, "customer_id": "cus_123", "device_id": null },
        "context":  { "ip": null, "user_agent": null, "locale": null, "page": null, "campaign": null },
        "properties": {
          "cart_id": "cart_abc",
          "item_count": 3,
          "subtotal_minor": 12990,
          "currency": "BRL"
        }
      }
    ]
  }'
```

> Use UUIDv7 for `event_id` (the SDKs do this automatically — see
> `uuid@^14` `v7()`). Anything else is rejected.

## Reading the response

The endpoint always returns **per-event** results. Partial acceptance is
non-negotiable: one bad event does **not** block the rest of the batch.
Full reason-code list is in [`docs/api/openapi.yaml`](../api/openapi.yaml)
(search for `BatchReasonCode`). Common shapes:

### Full accept

```json
{
  "accepted": [
    { "event_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551", "status": "accepted" }
  ],
  "rejected": []
}
```

### Partial accept (mix)

```json
{
  "accepted": [
    { "event_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551", "status": "accepted" }
  ],
  "rejected": [
    {
      "event_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f552",
      "status": "rejected",
      "code": "invalid_properties",
      "detail": {
        "event": "checkout.started",
        "schema_version": 1,
        "path": ["item_count"],
        "message": "Number must be positive"
      }
    }
  ]
}
```

### Closed set of rejection codes

```text
unsupported_schema_version    you sent a schema_version the catalog does not register
schema_version_sunset         the version is registered but past its sunset_at
unknown_event                 the event name is not in the catalog at all
invalid_properties            properties failed the Zod schema for (event, version)
invalid_envelope              the canonical envelope itself is malformed
forbidden_field_rejected      hit the reject list (e.g. cvv, password) — fix your producer
duplicate                     short-window dedupe caught a re-send (not an error)
publish_failed                transient ingester->Redpanda failure; retry with backoff
invalid_request               the batch envelope itself is malformed (status 400)
```

If you see `unknown_event`, you forgot [Phase 3](./03-event-names-and-schemas.md).
If you see `invalid_properties`, your `properties` do not match the
registered Zod schema for that `(event, schema_version)` pair.

### HTTP-level error responses

`401` (`missing_api_key` / `invalid_api_key`), `403` (`origin_not_allowed`),
`413` (`payload_too_large`), `400` (`invalid_request`) — full Problem Details
bodies in the OpenAPI doc. The single mapping for every auth-reject reason
(`missing_api_key` vs `invalid_api_key`) is intentional: it prevents
enumeration attacks.

## Step 6.1 — Confirm the event landed

The simplest authoritative check is to look at the *operator-side* state.
Use `polaris audit list` if your environment audits ingestion events, or
hit the ingester's own metrics endpoint:

```bash
# Live counter exposed at /metrics on the ingester (Prometheus exposition).
curl -s https://ingest.polaris.internal/metrics | \
  grep 'polaris_ingest_batch_accepted_total{project_id="your_project"'
```

For a fuller view of *control-plane* state changes related to your project
(key issuance, destination creation, etc.) and to confirm operator
activity:

```bash
polaris audit list \
  --project your_project \
  --env production \
  --since 2026-05-15T00:00:00Z \
  --limit 20
```

> `polaris audit list` shows **mutating CLI commands** (key creates,
> destination changes, replay jobs, DLQ retries, etc.) — not raw ingestion
> events. To see whether a *specific event* reached Redpanda
> `raw.events`, you go through `clickhouse-client` /
> `@polaris/shared-clickhouse` against `analytics_raw` (next phase) or ask
> the operator to tail the topic. Routine "did my event land" verification
> is done via the metrics endpoint and the ClickHouse query in
> [Phase 7](./07-analytics.md).

## Step 6.2 — Bulk-export your state for a forensic check

If you suspect a key is wrong or a source is in the wrong shape, bulk
export the relevant runtime state:

```bash
polaris export api-keys --project your_project --env production
polaris export sources  --project your_project --env production
polaris export destinations --project your_project --env production
```

These commands return JSON. The `api-keys` export **never** includes the
argon2id hash or the on-wire token — only metadata. The `destinations`
export emits the `secret_ref` literal (`env:META_CAPI_TOKEN_...`) but
never the resolved secret value.

Full operator-facing reference: [Audit and Export](../development/audit-and-export.md).

## What if the response is `accepted` but you do not see the event downstream?

That is *expected* during the first few hundred milliseconds — the path
is:

```text
Ingester -> Redpanda raw.events -> processors -> Redpanda derived topics
        -> destination consumers + ClickHouse Kafka Engine
        -> analytics_raw -> projection tables
```

If you wait a minute and still see nothing in analytics, the most likely
issues are:

- **DLQ:** an event accepted by the ingester later failed in a processor
  or consumer. Check `polaris dlq list --vendor <vendor>` (operator) and
  the [DLQ runbook](../operations/destination-dlq-triage.md).
- **Processor lag:** the analytics-projector is behind. Operators monitor
  this via dashboards described in [Observability](../development/observability.md).

See [Phase 10 — Troubleshooting](./10-troubleshooting.md).

## Done when

- An SDK `track()` call (or a `curl` POST) returned `accepted` for your
  `event_id`.
- The matching metric on `/metrics` ticked.
- *(Optional)* You can already see the event in the analytics surface —
  next phase confirms this end to end.

## Next

[Phase 7 — View it in analytics](./07-analytics.md).
