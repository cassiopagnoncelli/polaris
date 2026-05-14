# P9-003: Meta CAPI Consumer v1

Status: Done

## Goal

Implement the first Meta CAPI destination consumer with code-only mappings and vendor dedupe support.

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
consumers/meta-capi/v1/
packages/shared-destinations/
docs/destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
db schema changes not needed for this consumer
```

## Implementation Notes

- Use stable Polaris delivery IDs as vendor dedupe IDs where supported (Meta accepts `event_id` for cross-channel dedupe).
- Do not place Meta semantics upstream.
- Do not store access tokens in PostgreSQL.
- If live Meta API access is unavailable, implement against an interface and test with a mock transport.
- Ship `consumers/meta-capi/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). The SPEC documents field mapping per canonical event, normalization rules (Meta requires sha256(lowercase(trim(email))) for `em`, similar for `ph`, `external_id`), error class table, rate-limit profile, and the Meta API version the consumer targets.
- Normalization composes from `packages/shared-destination-normalize/`; Meta-specific rules (action_source inference, fbp/fbc cookie passthrough) live in `consumers/meta-capi/v1/normalize/`.

## Acceptance Criteria

- [x] Versioned consumer exists with manifest/changelog.
- [x] `SPEC.md` filled from the consumer SPEC template documents at least one canonical event end-to-end (mapping table, normalization, dedupe, error classes, fixtures).
- [x] At least one mapping is implemented in code.
- [x] Vendor dedupe field handling is tested.
- [x] Delivery records are written.
- [x] Replay suppression is honored.
- [x] Mock transport tests cover success and failure cases.

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
  consumers/meta-capi/v1/                                              new package
    package.json
    tsconfig.json
    vitest.config.ts
    consumer.manifest.yaml
    CHANGELOG.md
    SPEC.md
    src/
      app.ts                       Fastify shell + DestinationConsumer wiring (with dlqRecords)
      config.ts                    Zod env schema (service+http+redpanda+postgres+meta)
      deliverer.ts                 fetch + access_token query param + error class mapping + token redaction
      descriptor.ts                DestinationDescriptor with frozen per-event MapperMap
      descriptor-identity.ts       pinned vendor + per-stage versions + META_GRAPH_API_VERSION
      index.ts                     public barrel
      main.ts                      binary entry point
      mapper.ts                    checkout.started/payment.approved/user.identified mappers
                                   + buildUserData + inferActionSource
      types.ts                     MetaCapiPayload, MetaCapiUserData, MetaCapiCustomData,
                                   ResolvedMetaCapiSecret
    test/
      config.test.ts               3 tests
      deliverer.test.ts            21 tests
      integration.test.ts          5 tests (handleEvent end-to-end + DLQ persistence)
      mapper.test.ts               22 tests
      fixtures/normalized.ts        shared fixture builders
      fixtures/checkout-started.input.json    illustrative canonical envelope
      fixtures/checkout-started.output.json   illustrative Meta payload shape
  consumers/webhook-sink/v1/src/app.ts                                 add dlqRecords wiring (retrofit
                                                                      so webhook-sink also populates
                                                                      the P9-007 triage queue)
  docs/implementation/kanban.md                                        move P9-003 Backlog → Done
  docs/implementation/tasks/P9-003-...md                               Status: Done + checked AC

Commands run:
  pnpm install
  pnpm typecheck                  (workspace; clean)
  pnpm lint                       (workspace; clean)
  pnpm format:check               (workspace; clean)
  pnpm test                       (workspace: 1551 passed, 1 skipped)
  pnpm test:scripts               (59 passed)

Checks passed:
  typecheck, lint, format:check, test, test:scripts

Known gaps:
  - First/last name (fn/ln) slots in user_data are NOT mapped. The
    canonical envelope has no first/last name field; a future minor
    can add an `identityFromProperties` hook when a producer ships
    name data.
  - fbp / fbc browser tracking cookies are not yet flattened from
    `properties` into `user_data`. A future minor can add the hook.
  - Mobile-source action_source inference is `system_generated` until
    FlatContext carries `app_*` slots (a future normalize-layer
    extension).
  - No live Meta sandbox test. Mock-transport coverage is the contract
    surface; sandbox testing is documented as an operator procedure
    against the `test_event_code` secret slot.
```

