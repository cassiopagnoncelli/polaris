# P9-002: Webhook Sink Consumer v1

Status: Done

## Goal

Implement a simple webhook destination consumer for internal testing and destination runtime validation.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P6-004

## Write Scope

Allowed:

```text
consumers/webhook-sink/v1/
catalog/events/
packages/shared-destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Use this as the first real destination consumer because it can be tested without vendor credentials.
- Mapping remains code-only.
- Support delivery records, retries, and DLQs.
- Use a mock destination endpoint in tests where practical.
- Ship `consumers/webhook-sink/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). Webhook-sink is the canonical exemplar — this SPEC also serves as a worked example for vendor consumers landing later.

## Acceptance Criteria

- [x] Versioned consumer exists with manifest/changelog.
- [x] Consumer reads canonical events from configured topic.
- [x] Consumer sends HTTP webhook payloads.
- [x] Delivery records are written.
- [x] Retry and DLQ behavior are tested.
- [x] `SPEC.md` filled from the consumer SPEC template covers field mapping, error class table, rate limit profile, and test-fixture references for at least one canonical event.

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
  consumers/webhook-sink/v1/                      new package
    package.json
    tsconfig.json
    vitest.config.ts
    consumer.manifest.yaml
    CHANGELOG.md
    SPEC.md
    src/
      app.ts                Fastify shell + DestinationConsumer wiring
      config.ts             Zod env schema (service+http+redpanda+postgres+sink)
      deliverer.ts          fetch + HMAC-SHA256 + error class mapping
      descriptor.ts         DestinationDescriptor with passthrough mapper Proxy
      descriptor-identity.ts pinned vendor + per-stage versions
      index.ts              public barrel
      main.ts               binary entry point
      mapper.ts             pure canonical → WebhookPayload mapper + stampDelivery
      types.ts              WebhookPayload + ResolvedWebhookConfig
    test/
      config.test.ts        5 tests
      deliverer.test.ts     25 tests
      integration.test.ts   6 tests (handleEvent end-to-end)
      mapper.test.ts        8 tests
      fixtures/normalized.ts shared fixture builders
  docs/implementation/kanban.md                   moved P9-002 Ready → Done
  docs/implementation/tasks/P9-002-...md          Status: Done + checked AC

Commands run:
  pnpm install
  pnpm typecheck                  (workspace; clean)
  pnpm lint                       (workspace; clean)
  pnpm format:check               (workspace; clean)
  pnpm test                       (workspace: 1447 passed, 1 skipped)
  pnpm test:scripts               (59 passed)

Checks passed:
  typecheck, lint, format:check, test, test:scripts

Known gaps:
  - Per-event golden fixture pairs are intentionally omitted: webhook-sink
    is event-agnostic (every canonical event passes through the same
    mapper). Future vendor consumers MUST ship per-event fixtures per SPEC.
  - The deliverer hard-codes `X-Polaris-*` header names. If a downstream
    receiver complains about lowercase canonical-form headers, a future
    version can introduce a configurable header prefix.
  - The DLQ producer in app.ts is a real PolarisProducer; tests inject a
    no-op stub. End-to-end DLQ behavior is exercised through
    @polaris/shared-destinations' runtime tests (P9-001b), not duplicated
    here.
```

