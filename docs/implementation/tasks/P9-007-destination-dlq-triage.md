# P9-007: Destination Delivery Records and DLQ Triage

Status: Done

## Goal

Make destination delivery records and DLQs inspectable and operationally useful.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P6-001

## Write Scope

Allowed:

```text
apps/polaris-cli/
packages/shared-destinations/
docs/operations/
db/
migrations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
```

## Implementation Notes

CLI commands should cover:

```text
polaris deliveries list
polaris deliveries show <delivery_id>
polaris dlq list
polaris dlq show <id>
polaris dlq retry <id>
polaris dlq mark-resolved <id>
```

Retry commands must respect idempotency and replay policy.

## Acceptance Criteria

- [x] Delivery inspection commands exist.
- [x] DLQ inspection commands exist.
- [x] Retry/resolve actions are audited.
- [x] Secrets are absent from delivery/DLQ output.
- [x] Runbook explains triage workflow.

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
  db/migrations/20260514000001_create_dlq_records.sql                 new
  packages/shared-destinations/
    src/db/dlq-records.ts                                              new (in-memory + Kysely repo)
    src/db/delivery-records.ts                                         add findByDestinationId + filter
    src/dlq.ts                                                         persist to dlq_records when supplied
    src/runtime.ts                                                     thread dlqRecords through processOne
    src/index.ts                                                       re-export new dlq + list types
    test/dlq-records.test.ts                                           new (18 behavioral tests)
    test/delivery-records-list.test.ts                                 new (5 tests)
    test/runtime-behaviors.test.ts                                     +3 dlq persistence tests
  apps/polaris-cli/
    package.json                                                       add @polaris/shared-destinations + shared-kafka deps
    src/commands/deliveries/index.ts                                   new group
    src/commands/deliveries/list.ts                                    new (filter + json)
    src/commands/deliveries/show.ts                                    new
    src/commands/dlq/index.ts                                          new group
    src/commands/dlq/list.ts                                           new (--destination | --vendor scoping)
    src/commands/dlq/show.ts                                           new (payload preview)
    src/commands/dlq/snapshot.ts                                       new (audit snapshot shape)
    src/commands/dlq/retry.ts                                          new (republish + mark resolved + audit)
    src/commands/dlq/mark-resolved.ts                                  new (idempotent + audit)
    src/commands/index.ts                                              register new groups
    test/deliveries-dlq-commands.test.ts                               new (23 behavioral tests)
  docs/operations/destination-dlq-triage.md                            new runbook
  docs/implementation/kanban.md                                        P9-007 → Done
  docs/implementation/tasks/P9-007-destination-dlq-triage.md           Status: Done + checked AC

Commands run:
  pnpm install
  pnpm typecheck                  (workspace; clean)
  pnpm lint                       (workspace; clean)
  pnpm format:check               (workspace; clean)
  pnpm test                       (workspace: 1497 passed, 1 skipped)
  pnpm test:scripts               (59 passed)

Checks passed:
  typecheck, lint, format:check, test, test:scripts

Known gaps:
  - Early-stage runtime failures (decode_failed, missing_destination_id)
    publish to Kafka DLQ only — they don't have an envelope so dlq_records
    can't be populated without violating the FK on project_id. These
    are loud + rare in normal operation; runbook documents the
    kafkacat / Redpanda console fallback.
  - The CLI's `polaris dlq retry` opens a short-lived Kafka producer per
    invocation. Bulk retry loops (see runbook) re-pay the connect cost
    per row. A future enhancement could batch retries through a single
    producer session, but the existing UX is correct.
  - There is no auto-pruning of `dlq_records`. Operators run scheduled
    cleanup (out of scope here); when the operations team lands the
    retention runbook v2 it can add a sweep.
```

