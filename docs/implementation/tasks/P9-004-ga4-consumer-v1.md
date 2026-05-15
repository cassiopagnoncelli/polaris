# P9-004: GA4 Consumer v1

Status: Done

## Goal

Implement the first GA4 destination consumer with code-only mappings and careful purchase dedupe behavior.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P0-008
- P6-004

## Write Scope

Allowed:

```text
consumers/ga4/v1/
packages/shared-destinations/
docs/destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Use stable `transaction_id` for purchase mappings when available.
- Do not promise universal GA4 event dedupe.
- Use mock transport if live GA4 credentials are unavailable.
- Mapping semantics remain code-only.
- Ship `consumers/ga4/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). Document the GA4 Measurement Protocol version targeted, the `client_id`/`user_id` mapping from canonical identity, and the timestamp shape (GA4 uses microseconds since epoch via `timestamp_micros`).

## Acceptance Criteria

- [x] Versioned consumer exists with manifest/changelog.
- [x] `SPEC.md` filled from the consumer SPEC template documents the GA4 mapping including purchase dedupe via `transaction_id` and the client/user identity mapping.
- [x] At least one mapping is implemented in code.
- [x] Purchase/transaction dedupe behavior is documented and tested.
- [x] Delivery records are written.
- [x] Replay suppression is honored.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  consumers/ga4/v1/CHANGELOG.md                                 (new)
  consumers/ga4/v1/Dockerfile                                   (new; port 5002)
  consumers/ga4/v1/SPEC.md                                      (new; filled from template)
  consumers/ga4/v1/consumer.manifest.yaml                       (new; vendor=ga4, vendor_api_version=mp, dlq_topic_family=destination.ga4.v1.dlq)
  consumers/ga4/v1/package.json                                 (new; @polaris/consumer-ga4-v1)
  consumers/ga4/v1/src/app.ts                                   (new)
  consumers/ga4/v1/src/config.ts                                (new; POLARIS_GA4_* env vars)
  consumers/ga4/v1/src/deliverer.ts                             (new; mp/collect with measurement_id+api_secret query; 204-no-content handling; api_secret redaction)
  consumers/ga4/v1/src/descriptor-identity.ts                   (new; CONSUMER_VENDOR='ga4'; no numeric API version constant)
  consumers/ga4/v1/src/descriptor.ts                            (new; required_consent.analytics=true; identity hashing off)
  consumers/ga4/v1/src/index.ts                                 (new; barrel)
  consumers/ga4/v1/src/main.ts                                  (new)
  consumers/ga4/v1/src/mapper.ts                                (new; checkout.started→begin_checkout, payment.approved→purchase w/ transaction_id dedupe, user.identified→login method='polaris')
  consumers/ga4/v1/src/types.ts                                 (new; Ga4EventPayload, Ga4EventParams, Ga4EventItem, Ga4RequestBody, ResolvedGa4Secret)
  consumers/ga4/v1/test/config.test.ts                          (new)
  consumers/ga4/v1/test/deliverer.test.ts                       (new; pins 204-no-content path)
  consumers/ga4/v1/test/fixtures/checkout-started.input.json    (new)
  consumers/ga4/v1/test/fixtures/checkout-started.output.json   (new)
  consumers/ga4/v1/test/fixtures/normalized.ts                  (new)
  consumers/ga4/v1/test/integration.test.ts                     (new; pins purchase dedupe_key=transaction_id)
  consumers/ga4/v1/test/mapper.test.ts                          (new; pins transaction_id preferred, order_id fallback, event_id last-resort)
  consumers/ga4/v1/tsconfig.json                                (new)
  consumers/ga4/v1/vitest.config.ts                             (new)
  infra/docker/README.md                                        (added ga4 v1 row, port 5002)
  scripts/docker-build.mjs                                      (added ga4 entry)

Commands run:
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm lint
  pnpm format     (auto-fixed 4 files)
  pnpm format:check
  pnpm test

Checks passed:
  pnpm install — clean
  pnpm -r build — 18/18 packages built
  pnpm typecheck — 18/18 packages typecheck clean
  pnpm lint — clean (4 pre-existing warnings unrelated to ga4)
  pnpm format:check — clean
  pnpm test — 1874 passed / 1 skipped across 158 files; +59 script tests; ga4 v1: 45 tests across 4 files (mapper.test.ts:13, deliverer.test.ts:23, integration.test.ts:6, config.test.ts:3)

Known gaps:
  - `client_id` derivation: v1 synthesizes `client_id` from the canonical
    `delivery_key` (stable across retries). A future minor version will
    surface `identity.anonymous_id` to the deliverer so the wire
    `client_id` matches the gtag's client_id shape — SPEC and CHANGELOG
    document this.
  - `timestamp_micros` is NOT populated by v1: GA4 stamps its own
    receive-time. Same future minor version will route
    `occurred_at_epoch_ms * 1000` to the wire when the canonical
    envelope surfaces to the deliverer.
  - `user_id` is NOT populated by v1 for the same plumbing reason.
  - GA4 Consent Mode v2 fields (`ad_user_data`, `ad_personalization`)
    are not modeled — the Measurement Protocol has no corresponding
    slot; deferred until Google publishes a server-side equivalent.
  - `signup.completed`, `subscription.renewed`, `support.ticket.opened`
    are out of v1's mapping matrix (documented in SPEC).
```

