# Governance

This page is the operator-eye view of how the SDK interacts with the platform's event-governance rules. The authoritative reference is [Event Contract](../architecture/01-event-contract.md).

## `schema_version` per event

Every event carries an integer `schema_version`. The SDK defaults to `1` and accepts an override per call:

```ts
// Use schema_version 2 for this event.
await sdk.track("payment.approved", {
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
  payment_method_metadata: { network: "visa" }, // new field in v2
}, {
  schemaVersion: 2,
});
```

The ingester validates the `properties` against the registered Zod schema for that exact `(event_name, schema_version)` pair. The catalog stores both `payment.approved.v1.ts` and `payment.approved.v2.ts`; they coexist until the deprecated version is sunset.

### What the SDK does and does not enforce

- The SDK validates that `schemaVersion` is a positive integer. It does **not** know the catalog — there is no "is this version registered?" check.
- The SDK does **not** know whether a given (event, version) combination is deprecated. The ingester returns reason `schema_version_sunset` if the producer is using a version past its sunset date.
- The SDK does **not** validate `properties` against the catalog schema. The ingester is authoritative.

If you send an unregistered version, the ingester returns `unsupported_schema_version` and the SDK drops the event with `permanent_failure`. See [Retries and Errors / Permanent reason codes](./retries-and-errors.md#permanent-reason-codes-never-retried).

## Deprecation flow

The catalog flow for evolving an event:

1. Author the new version: `libs/spec/src/events/<domain>/<event>.v<N+1>.ts`.
2. Register it in the catalog with `lifecycle: active`.
3. Mark the previous version `lifecycle: deprecated` with a `sunset_at` (default 90 days).
4. Producers migrate during the deprecation window; the CLI and dashboards surface deprecated-version traffic.
5. After `sunset_at`, the ingester rejects the old version with reason `schema_version_sunset`.
6. The deprecated schema definition stays in the catalog for replay correctness — `raw.events` may still contain old events during retention.

As an SDK operator, your job during a deprecation window is to update your producer code to use the new `schemaVersion`. The SDK does not auto-migrate.

```ts
// Before: implicit v1.
await sdk.track("payment.approved", { amount: 12990, currency: "BRL" });

// After: explicit v2.
await sdk.track("payment.approved", {
  amount: 12990,
  currency: "BRL",
  payment_method: "credit_card",
  payment_method_metadata: { network: "visa" },
}, {
  schemaVersion: 2,
});
```

The SDK ships no event-catalog index. You learn about active versions and deprecation dates from the catalog itself and from your operations team. See [Event Contract / Sunset workflow](../architecture/01-event-contract.md#sunset-workflow).

## Forbidden-field policy (reject vs redact)

The platform applies a **two-tier code-backed policy** at ingestion:

- **Reject list** — fields whose mere presence indicates a producer bug. The entire event is rejected with reason `forbidden_field_rejected`.
- **Redact list** — fields where the producer can legitimately send the value but the raw form must not be stored. The field is replaced with `"[REDACTED:<reason>]"` and the event continues.

The default principle is **default-capture, narrow-reject** — only `pii_card` and `pii_secret` rules block capture. Everything else passes through; projects in regulated environments may add stricter redaction rules in `definitions/policy/forbidden-fields.<project_id>.ts`.

### What the SDK does and does not do

- The SDK does **not** evaluate the forbidden-field policy. The ingester does.
- The SDK does **not** redact, scrub, or normalise property values.
- A producer that includes a reject-listed field gets the whole event back with `forbidden_field_rejected` (a permanent rejection — the SDK drops the event and does not retry).
- A producer that includes a redact-listed field gets the event accepted, but downstream the field value is `"[REDACTED:<reason>]"`.

This is intentional. Centralising the policy in `definitions/policy/forbidden-fields.ts` means SDK upgrades do not change rejection semantics. Producers have one source of truth.

### Common reject-listed fields (platform defaults)

```text
pii_card    — cvv, cvc, card_security_code, card_number_full
pii_secret  — password, passwd, pwd, authorization, authorization_header,
              session_cookie, raw cookie blobs,
              private_key, priv_key, PEM-encoded private key bodies
```

If your event needs to convey card data, send `card_brand` and `card_last4` separately; do not send `card_number_full`. If you need authentication state, send a boolean or token *hash*, never the raw token.

### Common redact-listed patterns (platform defaults)

```text
Luhn-valid 13-19 digit PAN in any field other than the explicit card_number field   → reason pii_card
AWS access key signatures (AKIA + base32 pattern)                                    → reason pii_secret
GitHub token signatures (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)                      → reason pii_secret
JWT three-segment base64url pattern in fields outside identity.*                     → reason pii_secret
Generic 32+ byte hex or base64 strings in unexpected fields                          → reason pii_secret
```

The redact-with-metric pattern means the ingester strips the value AND records a metric (`polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}`). The leak is observable; the event itself continues.

### Reason codes

Closed set, stable across versions:

```text
pii_card        full or partial card number
pii_account     bank account or IBAN
pii_secret      detected high-entropy secret
policy          listed by name in the project or platform policy
length          exceeds configured length cap
pattern_match   matched a configured pattern rule
```

If your SDK call returns one of these, treat it as a producer-side bug. Fix the producer; do not retry.

## `consent` and `privacy` envelope fields

The canonical envelope includes optional `consent` and `privacy` blocks:

```json
{
  "consent": {
    "analytics": true,
    "marketing": false,
    "personalization": true
  },
  "privacy": {
    "classification": "internal"
  }
}
```

The SDK accepts these via `TrackOptions.consent` and `TrackOptions.privacy`:

```ts
await sdk.track("page.viewed", {
  path: "/home",
  search: null,
  title: "Home",
  referrer: null,
}, {
  schemaVersion: 2,
  consent: { analytics: true, marketing: false, personalization: true },
  privacy: { classification: "internal" },
});
```

### What the platform does with them

Per [Event Contract / Privacy and Consent](../architecture/01-event-contract.md#privacy-and-consent):

- Polaris **records** privacy and consent metadata.
- Polaris does **not enforce** consent in v1: events are not rejected because consent fields are `false`.
- Processors are not required to honour consent metadata initially.
- Destination consumers **may** use consent fields when the vendor protocol requires them (e.g., signal mapping), but enforcement remains best-effort in v1.

Producers remain responsible for deciding what they are allowed to collect. The platform records the consent state at the moment of capture; downstream code can use it.

### SDK-side conventions

- Send the consent state that was true at the moment of the event. Do not retro-apply later consent state to earlier events.
- Send the consent state as the user has actually configured it, not the legal default. A user who declined analytics should have `consent.analytics: false` even though most events still fire.
- If your application has a consent boundary (a banner the user must interact with), gate `track()` calls in your application code, not in the SDK. The SDK does not know which events are analytics events and which are operational.

### Setting consent in `defaultContext`

There is no `defaultConsent` option; consent is per-event. If your application has a single consent state for the whole session, pass it explicitly on every event, or wrap `sdk.track` in your own helper that injects the current consent:

```ts
function track(event: string, properties?: Record<string, unknown>): Promise<string> {
  return sdk.track(event, properties, {
    consent: getCurrentConsentState(),
    privacy: { classification: "internal" },
  });
}
```

## What you do **not** put in `properties`

A short, opinionated list, derived from the forbidden-field defaults:

- raw card numbers, CVVs, security codes
- raw passwords, password hashes, password-related strings
- raw bearer tokens, API keys, session cookies, authorization headers
- PEM-encoded private keys (or anything that looks like one)
- raw IBANs or full bank account numbers (these are project-policy redactable; default platform behaviour leaves them as `pii_account` patterns where matched)

If you need to convey one of these, find a canonical representation:

- card data → `card_brand`, `card_last4`, `card_country`
- authentication state → boolean or hash, never the raw token
- bank accounts → tokenised reference owned by your payments processor

## What goes in `properties` vs `context` vs `identity`

The envelope is rigid:

- `properties` is the event-specific payload. Owner-defined shape per event, validated against the catalog.
- `context` is event-agnostic context (URL, locale, user agent, campaign).
- `identity` is the SDK-managed identity block (`anonymous_id`, `session_id`, `customer_id`, `device_id`).

Do not duplicate identity into `properties`. Do not duplicate properties into `context`.

## Cross-reference

- [Event Contract](../architecture/01-event-contract.md) — canonical envelope, forbidden-field policy, schema evolution.
- [Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md) — ingester responsibilities and reason codes.
