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

### P0 Foundation

- [P0-002 TypeScript Tooling Baseline](./tasks/P0-002-typescript-tooling.md)
- [P0-003 Shared Config Package](./tasks/P0-003-shared-config.md)
- [P0-004 Shared Logger Package](./tasks/P0-004-shared-logger.md)
- [P0-005 Shared Errors and Service Bootstrap](./tasks/P0-005-service-bootstrap.md)
- [P0-006 Shared Schemas and Event Catalog](./tasks/P0-006-shared-schemas-catalog.md)
- [P0-007 Shared Kafka Package](./tasks/P0-007-shared-kafka.md)
- [P0-008 Shared Secrets Package](./tasks/P0-008-shared-secrets.md)
- [P0-009 Forbidden-Field Policy](./tasks/P0-009-forbidden-field-policy.md)
- [P0-010 Shared ClickHouse Client Package](./tasks/P0-010-shared-clickhouse-client.md)

### P1 Local Infrastructure

- [P1-002 PostgreSQL Migration Scaffold](./tasks/P1-002-postgres-migrations.md)

### P2 Ingester

- [P2-001 Ingester API Shell](./tasks/P2-001-ingester-api-shell.md)
- [P2-002 Ingester API Key Auth](./tasks/P2-002-ingester-api-key-auth.md)
- [P2-003 Ingester Batch Validation and Raw Publish](./tasks/P2-003-ingester-batch-raw-publish.md)

### P3 SDKs

- [P3-001 Node SDK Core](./tasks/P3-001-node-sdk-core.md)
- [P3-002 Web SDK Identity Persistence](./tasks/P3-002-web-sdk-identity-persistence.md)
- [P3-003 Web SDK Queue and Transport](./tasks/P3-003-web-sdk-queue-transport.md)

### P4 Processing and ClickHouse

- [P4-001 Analytics Processor Skeleton](./tasks/P4-001-analytics-processor.md)
- [P4-002 ClickHouse Ingestion Integration](./tasks/P4-002-clickhouse-ingestion.md)

### P5 Vertical Slice

- [P5-001 Vertical Slice Smoke Test](./tasks/P5-001-vertical-slice-smoke.md)
- [P5-002 Developer Runbook](./tasks/P5-002-developer-runbook.md)

### P6 Control-Plane CLI

- [P6-000 Control-Plane API Shell](./tasks/P6-000-control-plane-api-shell.md)
- [P6-001 Control-Plane CLI Shell](./tasks/P6-001-cli-shell.md)
- [P6-002 Projects and Sources CLI](./tasks/P6-002-projects-sources-cli.md)
- [P6-003 API Key Lifecycle CLI](./tasks/P6-003-api-key-lifecycle-cli.md)
- [P6-004 Destination Instance CLI](./tasks/P6-004-destination-instance-cli.md)
- [P6-005 Processor Runtime CLI](./tasks/P6-005-processor-runtime-cli.md)
- [P6-006 Audit and Export CLI](./tasks/P6-006-audit-export-cli.md)
- [P6-007 Operator Tokens and Mutation Gate](./tasks/P6-007-operator-tokens-and-mutation-gate.md)

### P7 Replay System

- [P7-001 Replay Job Model and CLI](./tasks/P7-001-replay-job-model-cli.md)
- [P7-002 Replay Planner Dry Run](./tasks/P7-002-replay-planner-dry-run.md)
- [P7-003 Processor Replay Executor](./tasks/P7-003-processor-replay-executor.md)
- [P7-004 Destination Replay Guardrails](./tasks/P7-004-destination-replay-guardrails.md)
- [P7-005 ClickHouse Rebuild Workflows](./tasks/P7-005-clickhouse-rebuild-workflows.md)

### P8 Production Processors

- [P8-001 Processor Runtime Helpers](./tasks/P8-001-processor-runtime-helpers.md)
- [P8-002 Identity Resolver v1](./tasks/P8-002-identity-resolver-v1.md)
- [P8-003 Sessionizer v1](./tasks/P8-003-sessionizer-v1.md)
- [P8-004 GeoIP Enricher v1](./tasks/P8-004-geoip-enricher-v1.md)
- [P8-005 Attribution Engine v1](./tasks/P8-005-attribution-engine-v1.md)
- [P8-006 Processor Manifests and Golden Fixtures](./tasks/P8-006-processor-manifests-fixtures.md)

### P9 Destination Consumers

- [P9-000 Shared Destination Normalization Package](./tasks/P9-000-shared-destination-normalize.md)
- [P9-001 Destination Consumer Runtime](./tasks/P9-001-destination-consumer-runtime.md)
- [P9-002 Webhook Sink Consumer v1](./tasks/P9-002-webhook-sink-consumer-v1.md)
- [P9-003 Meta CAPI Consumer v1](./tasks/P9-003-meta-capi-consumer-v1.md)
- [P9-004 GA4 Consumer v1](./tasks/P9-004-ga4-consumer-v1.md)
- [P9-005 TikTok Consumer v1](./tasks/P9-005-tiktok-consumer-v1.md)
- [P9-006 Braze Consumer v1](./tasks/P9-006-braze-consumer-v1.md)
- [P9-007 Destination Delivery Records and DLQ Triage](./tasks/P9-007-destination-dlq-triage.md)

### P10 Observability and Operations

- [P10-001 Observability Compose](./tasks/P10-001-observability-compose.md)
- [P10-002 Metrics Standardization](./tasks/P10-002-metrics-standardization.md)
- [P10-003 Grafana Dashboards](./tasks/P10-003-grafana-dashboards.md)
- [P10-004 Loki Logging Pipeline](./tasks/P10-004-loki-logging-pipeline.md)
- [P10-005 Alerts and Incident Runbooks](./tasks/P10-005-alerts-runbooks.md)
- [P10-006 DLQ Triage Runbook](./tasks/P10-006-dlq-triage-runbook.md)

### P11 Deployment, Security, and Data Lifecycle

- [P11-001 Production Dockerfiles](./tasks/P11-001-production-dockerfiles.md)
- [P11-002 CI Workflow](./tasks/P11-002-ci-workflow.md)
- [P11-003 Production Config Templates](./tasks/P11-003-production-config-templates.md)
- [P11-004 Production Secret Provider Adapter](./tasks/P11-004-production-secret-provider.md)
- [P11-005 Backup and Retention Runbooks](./tasks/P11-005-backup-retention-runbooks.md)
- [P11-006 Security Hardening](./tasks/P11-006-security-hardening.md)
- [P11-007 Release Versioning and Build Metadata](./tasks/P11-007-release-versioning-build-metadata.md)
- [P11-008 Topic Isolation and Per-Project Metrics](./tasks/P11-008-topic-isolation.md)

### P12 Release Readiness

- [P12-001 SDK Handbook](./tasks/P12-001-sdk-handbook.md)
- [P12-002 API Docs and OpenAPI Publishing](./tasks/P12-002-api-docs-openapi.md)
- [P12-003 Product Acceptance Test](./tasks/P12-003-product-acceptance-test.md)
- [P12-004 Internal Onboarding Guide](./tasks/P12-004-internal-onboarding-guide.md)
- [P12-005 Release Candidate Checklist](./tasks/P12-005-release-candidate-checklist.md)

## In Progress

No active cards.

## Review

No cards awaiting review.

## Blocked

No blocked cards.

## Done

No completed cards.
