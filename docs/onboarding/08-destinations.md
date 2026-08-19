# Phase 8 — Request destination enablement

A **destination** is a vendor pipeline that consumes derived events and
delivers them to an external system (Meta CAPI, TikTok Events, GA4 Measurement
Protocol, Braze, etc.). Polaris stores destination *runtime state* in
PostgreSQL; the actual mapping logic (event-to-vendor field maps) lives in
versioned consumer code under `sync/destinations/<vendor>/<version>/src/mapper.ts`.

> **The CLI never accepts mapping semantics as arguments.** Flags like
> `--field-map` or `--event-map` are refused at the validator. Mapping
> belongs in code, not in PostgreSQL — see the rule in
> `apps/polaris-cli/src/commands/destinations/index.ts` and
> [Architecture / Destinations](../architecture/06-destinations.md).

## Who does this

**Operators only.** `polaris destinations create` is `mutates: true`, the
secret material lives in the platform's secret provider, and the audit
trail must be operator-attributed. Your team requests a destination
instance via your operator channel.

What your team gives the operator:

- the **project** + **environment** the destination is scoped to
- the **vendor adapter** to use: `braze`, `ga4`, `meta-capi`, `tiktok`, or
  `webhook`. These are the `vendor` literals from each
  `sync/destinations/<name>/v1/consumer.manifest.yaml`, and a consumer only picks
  up destination rows whose `vendor` matches its own — so `webhook-sink`
  wants `--vendor webhook`, and a near-miss like `tiktok-events` produces
  a row no consumer ever reads.
- an **instance label** that is unique inside `(project, environment,
  vendor)` — typically the campaign or business unit (e.g.
  `storefront-acquisition`, `subscription-renewal`)
- the **secret reference** — the *name* of the credential in your secret
  provider, never the credential itself

## Step 8.1 — Operator creates the destination

```bash
polaris destinations create \
  --project your_project \
  --env production \
  --vendor meta-capi \
  --instance-label storefront-acquisition \
  --secret-ref env:META_CAPI_TOKEN_YOUR_PROJECT_PROD \
  --mode live \
  --max-concurrency 4 \
  --max-rps 50 \
  --retry-policy standard \
  --dead-letter-threshold 5 \
  --reason "P12-004 onboarding: storefront acquisition pipeline"
```

The CLI:

1. Refuses any mapping-shaped flag before any DB write.
2. Generates a `destination_id` of the shape `polaris_dst_<uuidv7>`.
3. Inserts the destination row with `status='active'` and the operational
   tuning columns above.
4. Writes the `audit_records` row in the same transaction (atomic).
5. Prints the `destination_id` to stdout.

Output:

```text
polaris destination created
  destination_id  polaris_dst_018f1c0b-7b50-7b12-9a2e-0e2f88d8f551
  project_id      your_project
  environment     production
  vendor          meta-capi
  instance_label  storefront-acquisition
  mode            live
  max_concurrency 4
  max_rps         50
  retry_policy    standard
  dlq_threshold   5
```

The operator hands you the `destination_id`. **Your team never sees the
secret value** — it lives in the configured secret provider (env var,
secret manager) and is resolved by the destination consumer at runtime,
never by the CLI or by your application.

## Step 8.2 — Operator can adjust operational tuning

Operators tune throughput, retries, and DLQ thresholds without touching
the mapper code:

```bash
polaris destinations update-ops polaris_dst_018f1c0b... \
  --max-concurrency 8 \
  --max-rps 100 \
  --reason "scale up for Black Friday"
```

`--reason` is **required** on `update-ops` so the audit row always carries
the operator's rationale.

## Step 8.3 — Enable / disable

Destinations can be paused without losing their configuration. `disable`
stops delivery; `enable` resumes it.

```bash
# Disable when the vendor is having an outage:
polaris destinations disable polaris_dst_018f1c0b... \
  --reason "meta-capi 502 storm 14:00-15:30 UTC; resume after vendor SP"

# Resume when the vendor is healthy again:
polaris destinations enable polaris_dst_018f1c0b...
```

Both are idempotent. Re-running `enable` on an active destination prints
`already active` and exits 0. Re-running `disable` on a disabled
destination preserves the original `disabled_reason` (it does not
overwrite).

## Step 8.4 — Replay opt-in (advanced)

When the operator runs a replay to backfill events, every destination
instance defaults to **opt-out**. Replayed events are suppressed at the
destination until an operator flips the per-instance opt-in:

```bash
polaris destinations enable-replay polaris_dst_018f1c0b... \
  --reason "backfill 2026-05-01..2026-05-10 for incident #4218"

# After the replay window ends, switch back to opt-out (the default):
polaris destinations disable-replay polaris_dst_018f1c0b... \
  --reason "backfill complete"
```

The default is safe-by-default: a replay does not silently re-fire events
to a vendor without an explicit opt-in. Architectural rationale:
[Architecture / Processors and Replay /
Replay Control Plane](../architecture/05-processors-and-replay.md).

## Step 8.5 — Inspect what is wired

```bash
polaris destinations list --project your_project --env production
polaris destinations show polaris_dst_018f1c0b...
polaris export destinations --project your_project --env production
```

Neither `destinations show` nor `destinations list` includes the
credential. It is stored in `destinations.secret_value` as plaintext and
is write-only through every Polaris surface: set it at create, replace it
with `polaris destinations rotate-secret`, and confirm it works by
whether deliveries are accepted rather than by reading it back.

`export destinations` is the bulk JSON dump for diff and review.

## What your team is responsible for

The team:

- requests the destination via the operator channel
- supplies the vendor adapter name, instance label, and the *name* of the
  secret in the secret provider
- monitors delivery metrics on the dashboards documented in
  [Observability](../development/observability.md)
- pages the operator (or files a DLQ ticket — see
  [Phase 9](./09-support-and-escalation.md)) when delivery is failing

The team does NOT:

- create the destination row
- handle the vendor secret material
- write or modify mapper code (that is a separate PR against
  `sync/destinations/<vendor>/<version>/src/mapper.ts`)
- enable replay opt-in on its own

## Done when

- The operator returns a `destination_id` from `polaris destinations create`.
- `polaris destinations show <destination_id>` shows `status=active`.
- Your team's dashboards show `polaris_destination_events_accepted_total`
  ticking for the new `destination_id`.

## Next

[Phase 9 — Support and escalation path](./09-support-and-escalation.md).
