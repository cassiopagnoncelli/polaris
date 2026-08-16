# Phase 10 — Troubleshooting

Common failure modes new project teams hit on this platform, and the
diagnostic move for each. The SDK-specific surface lives in
[SDK / Troubleshooting](../sdk/troubleshooting.md); this page is the
*platform-level* equivalent.

## 1. `unknown_event` in the per-event response

```json
{ "status": "rejected", "code": "unknown_event", "detail": { "event": "checkout.started" } }
```

**Meaning.** The ingester's catalog does not register that event name (or
the name does not exist in the catalog the running ingester picked up).

**Diagnostic move.**

1. Check the catalog has the file:
   `catalog/events/<domain>/<event>.v<n>.yaml`. If it is missing, you
   forgot [Phase 3](./03-event-names-and-schemas.md).
2. If the file exists, check that the running ingester has it. Schema
   registrations land via deploy, not at runtime. A merged-but-not-yet-deployed
   schema is the most common cause of this in staging shortly after a
   schema PR.
3. Talk to your schema owner / reviewer. They confirm the catalog state
   in your target environment.

This is **never** a code workaround. Polaris is strict-schema by design.

## 2. `invalid_properties` in the per-event response

```json
{
  "status": "rejected",
  "code": "invalid_properties",
  "detail": {
    "event": "checkout.started",
    "schema_version": 1,
    "path": ["item_count"],
    "message": "Number must be positive"
  }
}
```

**Meaning.** The event name is registered, but the `properties` payload
does not match the Zod schema for that `(event_name, schema_version)`
pair.

**Diagnostic move.**

1. Open the matching schema file at
   `packages/shared-schemas/src/events/<domain>/<event>.v<n>.ts`.
2. Diff your producer call against the schema. The `detail.path` array
   names the field that failed; `detail.message` is the Zod failure
   message.
3. Fix the producer. If the schema is wrong, evolve it — see [Schema
   Evolution](../architecture/01-event-contract.md#schema-evolution) for
   what is additive-safe versus what forces a `v2`.

## 3. Event accepted but missing in analytics

The ingester returned `accepted` and you can see the counter tick on
`/metrics`, but the event does not show up in your ClickHouse query.

**Meaning.** The event reached `raw.events` but failed somewhere in the
processing chain (processor crash, mapping error in a destination
consumer) and landed in a DLQ — *or* the analytics-projector is simply
behind.

**Diagnostic move.**

Start with the trace. It asks all four stores at once and is almost
always faster than working through them by hand:

```bash
polaris events trace <event_id> --project storefront
```

It prints, in order: whether the event was rejected at ingest, which
families / partitions / offsets it passed through and which processor
stamped each row, every destination attempt with its status, and any DLQ
entry. A stage that is absent says so, and says why — "rejected at
ingest, so it never reached the spine" is a different answer from "no
transport lineage in the retention window", and the command distinguishes
them.

Two things to know about the output:

- `--project` is required. It is the ingest-log sort key; without it the
  query is a full scan of the 30-day retention window.
- The transport half is bounded by that same 30-day TTL. For an older
  event, absent lineage means aged out, not never arrived — the command
  prints this reminder every time rather than trusting you to remember.

If the trace does not settle it, the individual stores:

1. Check processor lag on the dashboards listed in
   [Observability](../development/observability.md).
2. Check the DLQ:
   ```bash
   polaris dlq list --vendor analytics-projector --since 2026-05-15T00:00:00Z
   ```
3. If the event is in the DLQ, `polaris dlq show <dlq_id>` returns the
   full row including the failure reason. The operator decides whether
   to `retry` or `mark-resolved` (see [DLQ runbook](../operations/destination-dlq-triage.md)).
4. If the DLQ is empty and lag is normal, the event may have been
   dropped at the consumer's normalize stage (consent / no-identity /
   invalid). Check `delivery_records` for the destination, or page the
   on-call operator with the `event_id`.

**Watching it happen live.** When the question is "is anything arriving
at all", attach a tail:

```bash
polaris events tail --family resolved.events --project storefront --env production
```

This is safe to run against production. It is not a consumer: it joins no
group and writes no checkpoint, so it cannot move a real consumer's
position. Payloads are run through the same policy evaluator the ingester
uses (with the project's override applied) and then truncated to 2 KiB.
Ctrl-C detaches.

## 4. Destination not delivering

A destination is healthy in `polaris destinations show` (status active,
mode live), but vendor-side acceptance is zero.

**Meaning.** Delivery is being attempted and failing. Two common causes:
the vendor is rejecting the request shape, or the credential is wrong.

**Diagnostic move.**

1. List recent delivery attempts:
   ```bash
   polaris deliveries list <destination_id> --status failed_retryable --since 2026-05-15T00:00:00Z
   polaris deliveries list <destination_id> --status failed_permanent --since 2026-05-15T00:00:00Z
   ```
2. Inspect one attempt:
   ```bash
   polaris deliveries show <delivery_id>
   ```
   The row carries `vendor_response_summary` — the receiver's reason
   truncated to 1 KB. That string is your evidence.
3. If `vendor_response_summary` says "invalid signature" / "auth failed"
   / "credential expired", issue a new credential at the vendor and run
   `polaris destinations rotate-secret <id> --secret-value <new>
   --reason <why>`. Then resume delivery — the runtime picks up the new
   value within the 60s instance-cache window, no restart.
4. If `vendor_response_summary` describes a schema mismatch, the
   destination's mapper code (`consumers/<vendor>/v<n>/mappers/`) is
   probably stale relative to the vendor's API. File a follow-up to
   bump the consumer version.

Full triage flow is in the [Destination DLQ Triage runbook](../operations/destination-dlq-triage.md).

## 5. `forbidden_field_rejected` in the per-event response

```json
{
  "status": "rejected",
  "code": "forbidden_field_rejected",
  "detail": {
    "path": ["properties", "cvv"],
    "policy_reason": "pii_card",
    "message": "forbidden field 'properties.cvv' present (policy reason: pii_card)"
  }
}
```

**Meaning.** Your producer sent a field whose mere presence is a producer
bug — a CVV, raw card number, password, raw cookie, authorization header,
etc. See [Event Contract / Forbidden-Field Policy](../architecture/01-event-contract.md#forbidden-field-policy).

**Diagnostic move.**

1. **Fix the producer.** This is non-negotiable. The platform's defaults
   are intentionally narrow — only fields whose presence signals a bug.
2. If you have a legitimate need to capture *some signal* about the
   forbidden category, send the safe form (e.g. `card_brand` and
   `card_last4`, never `card_number_full` or `cvv`).
3. If you believe the rejection is a false positive (a legitimately-named
   field shadowed by a platform default), open a PR against
   `catalog/policy/forbidden-fields.<project_id>.ts` for a project-scoped
   override. **Cannot downgrade platform rejects without a documented
   exception note** — see [Policy / Project overrides](../architecture/01-event-contract.md#project-overrides).

## 6. `401 invalid_api_key` from the ingester

```http
401 Unauthorized
content-type: application/problem+json

{ "code": "invalid_api_key", "detail": "The provided API key is invalid or revoked." }
```

**Meaning.** Polaris collapses *every* auth-reject reason (malformed
header, no matching `api_key_id`, revoked row, hash mismatch, algorithm
mismatch) to the same `invalid_api_key` code so attackers cannot
enumerate which arm failed.

**Diagnostic move.**

1. `polaris keys list --project your_project --env <env>` (operator).
   Confirm the key you are using is `status=active`.
2. Confirm the key's environment matches the environment the ingester is
   running in. A staging key against the production ingester always
   returns `invalid_api_key`.
3. Confirm your producer is reading the token from the right env var /
   secret. The most common cause of this in dev is a `.env` mismatch.

## 7. `401 missing_api_key` from the ingester

**Meaning.** The `x-polaris-api-key` header is not present.

**Diagnostic move.**

- Confirm your SDK was constructed with `apiKey` set. With both `endpoint`
  *and* `apiKey` missing, the Web SDK silently constructs without a
  transport and `flush()` returns zero deliveries (see [SDK /
  Troubleshooting](../sdk/troubleshooting.md)). Wire `onError` so this
  becomes loud.
- If you are calling `/v1/events` with `curl`, you forgot the header.

## 8. `403 origin_not_allowed` from the ingester

**Meaning.** A browser POST hit the ingester from an `Origin` header that
is not on the per-source allow-list. The browser sees the standard CORS
failure path; server-to-server callers (no `Origin` header) bypass the
check.

**Diagnostic move.**

- Confirm the page's origin is on your source's allow-list. This is
  managed by the operator through the `source_allowed_origins` table.
- During development, the operator usually adds `http://localhost:<port>`
  variants explicitly.

## 9. SDK shows `permanent_failure` drops in production

**Meaning.** The transport returned a hard 4xx that the SDK does not retry.

**Diagnostic move.**

- Wire `onDrop` to capture the reason. Most common causes:
  - `401` / `403` — auth or origin. See items 6, 7, 8 above.
  - `404` — endpoint URL is wrong. Confirm the URL includes the path
    `/v1/events`.
  - `400` `invalid_request` — your batch envelope is malformed. Diff
    against the OpenAPI document's `BatchRequest` schema.
- `permanent_failure` is never a backoff problem — the SDK will not
  recover from it without a producer-side change.

## 10. Events arrive in production with `customer_id: null` when they should not

**Meaning.** Either `identify()` was not called before the event fired,
or `reset()` was called between login and the event.

**Diagnostic move.**

- For Web: log `sdk.getEnvelopeIdentity()` at the call site to see what
  the SDK thinks the current identity is.
- Confirm your login flow calls `sdk.identify(customerId)` *before* any
  post-login `track()` call.
- Confirm your logout flow's `reset()` is not running before the final
  pre-logout events have flushed.
- Full SDK-side detail is in [SDK / Troubleshooting / "Events arrive but
  `customer_id` is null"](../sdk/troubleshooting.md).

## When to file a task card instead of working around

Open a task card if:

- You hit a reason code not documented in the OpenAPI doc or in [SDK /
  Retries and Errors](../sdk/retries-and-errors.md).
- A documented schema-evolution rule does not behave as the doc says
  (e.g., adding an optional field rejects existing events).
- A destination delivery succeeds but the matching `delivery_records`
  row is missing.
- A `polaris audit ...` filter that should match returns nothing
  consistently.

Do not work around. The contracts in this guide are small; bugs in them
should be fixed at the source.
