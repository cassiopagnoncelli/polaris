# Polaris Implementation Kanban

This board is the coordination surface for implementation work.

## Board Rules

- One task per worker.
- A worker only edits files inside the task write scope.
- If multiple workers run in parallel, the coordinator updates this kanban to avoid merge conflicts.
- Workers may add handoff notes to their assigned task file.
- Move a card to `Blocked` if the task requires an architecture decision not covered by the docs.

## Ready

- [P0-001 Workspace Skeleton](./tasks/P0-001-workspace-skeleton.md)
- [P1-001 Local Core Compose](./tasks/P1-001-local-core-compose.md)
- [P1-003 ClickHouse DDL Skeleton](./tasks/P1-003-clickhouse-ddl-skeleton.md)

## Backlog

- [P0-002 TypeScript Tooling Baseline](./tasks/P0-002-typescript-tooling.md)
- [P0-003 Shared Config Package](./tasks/P0-003-shared-config.md)
- [P0-004 Shared Logger Package](./tasks/P0-004-shared-logger.md)
- [P0-005 Shared Errors and Service Bootstrap](./tasks/P0-005-service-bootstrap.md)
- [P0-006 Shared Schemas and Event Catalog](./tasks/P0-006-shared-schemas-catalog.md)
- [P0-007 Shared Kafka Package](./tasks/P0-007-shared-kafka.md)
- [P0-008 Shared Secrets Package](./tasks/P0-008-shared-secrets.md)
- [P1-002 PostgreSQL Migration Scaffold](./tasks/P1-002-postgres-migrations.md)
- [P2-001 Ingester API Shell](./tasks/P2-001-ingester-api-shell.md)
- [P2-002 Ingester API Key Auth](./tasks/P2-002-ingester-api-key-auth.md)
- [P2-003 Ingester Batch Validation and Raw Publish](./tasks/P2-003-ingester-batch-raw-publish.md)
- [P3-001 Node SDK Core](./tasks/P3-001-node-sdk-core.md)
- [P3-002 Web SDK Identity Persistence](./tasks/P3-002-web-sdk-identity-persistence.md)
- [P3-003 Web SDK Queue and Transport](./tasks/P3-003-web-sdk-queue-transport.md)
- [P4-001 Analytics Processor Skeleton](./tasks/P4-001-analytics-processor.md)
- [P4-002 ClickHouse Ingestion Integration](./tasks/P4-002-clickhouse-ingestion.md)
- [P5-001 Vertical Slice Smoke Test](./tasks/P5-001-vertical-slice-smoke.md)
- [P5-002 Developer Runbook](./tasks/P5-002-developer-runbook.md)

## In Progress

No active cards.

## Review

No cards awaiting review.

## Blocked

No blocked cards.

## Done

No completed cards.
