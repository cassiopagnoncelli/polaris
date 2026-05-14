# Polaris Implementation Kanban

This board is the coordination surface for implementation work.

## Board Rules

- One task per worker.
- A worker only edits files inside the task write scope.
- If multiple workers run in parallel, the coordinator updates this kanban to avoid merge conflicts.
- Workers may add handoff notes to their assigned task file.
- Move a card to `Blocked` if the task requires an architecture decision not covered by the docs.

## Ready

- [P7-004 Destination Replay Guardrails](./tasks/P7-004-destination-replay-guardrails.md)
- [P11-008 Topic Isolation and Per-Project Metrics](./tasks/P11-008-topic-isolation.md) (unblocked by P10-002)

## Backlog

### P6 Control-Plane CLI

_(no remaining backlog — all P6 tasks Ready or Done)_

### P7 Replay System

- [P7-003 Processor Replay Executor](./tasks/P7-003-processor-replay-executor.md)
- [P7-005 ClickHouse Rebuild Workflows](./tasks/P7-005-clickhouse-rebuild-workflows.md)

### P8 Production Processors

- [P8-006 Processor Manifests and Golden Fixtures](./tasks/P8-006-processor-manifests-fixtures.md)

### P9 Destination Consumers

- [P9-004 GA4 Consumer v1](./tasks/P9-004-ga4-consumer-v1.md)
- [P9-005 TikTok Consumer v1](./tasks/P9-005-tiktok-consumer-v1.md)
- [P9-006 Braze Consumer v1](./tasks/P9-006-braze-consumer-v1.md)

### P10 Observability and Operations

- [P10-003 Grafana Dashboards](./tasks/P10-003-grafana-dashboards.md)
- [P10-004 Loki Logging Pipeline](./tasks/P10-004-loki-logging-pipeline.md)
- [P10-005 Alerts and Incident Runbooks](./tasks/P10-005-alerts-runbooks.md)
- [P10-006 DLQ Triage Runbook](./tasks/P10-006-dlq-triage-runbook.md)

### P11 Deployment, Security, and Data Lifecycle

- [P11-003 Production Config Templates](./tasks/P11-003-production-config-templates.md)
- [P11-004 Production Secret Provider Adapter](./tasks/P11-004-production-secret-provider.md)
- [P11-007 Release Versioning and Build Metadata](./tasks/P11-007-release-versioning-build-metadata.md) (waiting on P11-001 + P8-006)

(P11-005 Backup and Retention Runbooks moved to Done.)

(P11-002 CI Workflow moved to Done.)

### P12 Release Readiness

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

### P0 Foundation

- [P0-001 Workspace Skeleton](./tasks/P0-001-workspace-skeleton.md) — merged in `207d4b9`
- [P0-002 TypeScript Tooling Baseline](./tasks/P0-002-typescript-tooling.md) — merged in `3590b97`
- [P0-003 Shared Config Package](./tasks/P0-003-shared-config.md) — merged in `a97a61d`
- [P0-004 Shared Logger Package](./tasks/P0-004-shared-logger.md) — merged in `2bd5a1f`
- [P0-005 Shared Errors and Service Bootstrap](./tasks/P0-005-service-bootstrap.md) — merged in `b3d2b90`
- [P0-006 Shared Schemas and Event Catalog](./tasks/P0-006-shared-schemas-catalog.md) — merged in `28ed3ed`
- [P0-007 Shared Kafka Package](./tasks/P0-007-shared-kafka.md) — merged in `e5129a8`
- [P0-008 Shared Secrets Package](./tasks/P0-008-shared-secrets.md) — merged in `e553de9`
- [P0-009 Forbidden-Field Policy](./tasks/P0-009-forbidden-field-policy.md) — merged in `c72263c`
- [P0-010 Shared ClickHouse Client Package](./tasks/P0-010-shared-clickhouse-client.md) — merged in `4cc726d`

### P1 Local Infrastructure

- [P1-001 Local Core Compose](./tasks/P1-001-local-core-compose.md) — merged in `912b544`
- [P1-002 PostgreSQL Migration Scaffold](./tasks/P1-002-postgres-migrations.md) — merged in `1af792a`
- [P1-003 ClickHouse DDL Skeleton](./tasks/P1-003-clickhouse-ddl-skeleton.md) — merged in `0742f4a`

### P2 Ingester

- [P2-001 Ingester API Shell](./tasks/P2-001-ingester-api-shell.md) — merged in `8f6982e`
- [P2-002 Ingester API Key Auth](./tasks/P2-002-ingester-api-key-auth.md) — merged in `0ff8fde`
- [P2-003 Ingester Batch Validation and Raw Publish](./tasks/P2-003-ingester-batch-raw-publish.md) — merged in `c8753df`

### P3 SDKs

- [P3-001 Node SDK Core](./tasks/P3-001-node-sdk-core.md) — merged in `98a3eb2` (cleanup `de6dea4`, identity restore `fd54203`)
- [P3-002 Web SDK Identity Persistence](./tasks/P3-002-web-sdk-identity-persistence.md) — merged in `bd7b477`
- [P3-003 Web SDK Queue and Transport](./tasks/P3-003-web-sdk-queue-transport.md) — merged in `889bb9f`

### P4 Processing and ClickHouse

- [P4-001 Analytics Processor Skeleton](./tasks/P4-001-analytics-processor.md) — merged in `5bbf133`
- [P4-002 ClickHouse Ingestion Integration](./tasks/P4-002-clickhouse-ingestion.md) — merged in `2795a31`

### P5 Vertical Slice

- [P5-001 Vertical Slice Smoke Test](./tasks/P5-001-vertical-slice-smoke.md) — merged in `e9c7651`
- [P5-002 Developer Runbook](./tasks/P5-002-developer-runbook.md) — merged in `ef21797`

### P6 Control-Plane CLI

- [P6-001 Control-Plane CLI Shell](./tasks/P6-001-cli-shell.md) — merged in `89d1521`
- [P6-002 Projects and Sources CLI](./tasks/P6-002-projects-sources-cli.md) — merged in `6756c72`
- [P6-003 API Key Lifecycle CLI](./tasks/P6-003-api-key-lifecycle-cli.md) — merged in `ac639f0`
- [P6-004 Destination Instance CLI](./tasks/P6-004-destination-instance-cli.md) — merged in `2f8679f`
- [P6-005 Processor Runtime CLI](./tasks/P6-005-processor-runtime-cli.md) — merged in `6b919cb`
- [P6-006 Audit and Export CLI](./tasks/P6-006-audit-export-cli.md) — merged in `29bcbef`
- [P6-007 Operator Tokens and Mutation Gate](./tasks/P6-007-operator-tokens-and-mutation-gate.md) — merged in `964f14a`
- [P6-000 Control-Plane API Shell](./tasks/P6-000-control-plane-api-shell.md) — merged in `0621843`

### P7 Replay System

- [P7-001 Replay Job Model and CLI](./tasks/P7-001-replay-job-model-cli.md) — merged in `f670d28` (salvaged from stalled worker; behavioral coverage closed by P7-001b)
- [P7-001b Replay CLI Behavioral Tests + Store Surface Cleanup](./tasks/P7-001b-replay-cli-behavioral-tests.md) — merged in `a7d7e1e`
- [P7-002 Replay Planner Dry Run](./tasks/P7-002-replay-planner-dry-run.md) — merged in `f017da8`

### P8 Production Processors

- [P8-001 Processor Runtime Helpers](./tasks/P8-001-processor-runtime-helpers.md) — merged in `3d4e09b`
- [P8-002 Identity Resolver v1](./tasks/P8-002-identity-resolver-v1.md) — merged in `a9dd1cf` (salvaged from stalled worker; behavioral coverage closed by P8-002b)
- [P8-002b Identity Resolver Behavioral Test Matrix](./tasks/P8-002b-identity-resolver-behavioral-tests.md) — merged in `bac7bc2`
- [P8-003 Sessionizer v1](./tasks/P8-003-sessionizer-v1.md) — merged in `12a6670`
- [P8-004 GeoIP Enricher v1](./tasks/P8-004-geoip-enricher-v1.md) — merged in `d8bf80d`
- [P8-005 Attribution Engine v1](./tasks/P8-005-attribution-engine-v1.md) — merged in `30cbdd4`

### P9 Destination Consumers

- [P9-000 Shared Destination Normalization Package](./tasks/P9-000-shared-destination-normalize.md) — merged in `318afc0`
- [P9-001 Destination Consumer Runtime](./tasks/P9-001-destination-consumer-runtime.md) — merged in `34c4fe8` (salvaged from stalled worker; behavioral coverage closed by P9-001b)
- [P9-001b Destination Consumer Runtime Behavioral Test Matrix](./tasks/P9-001b-destination-runtime-behavioral-tests.md) — merged in `f6318c3`
- [P9-002 Webhook Sink Consumer v1](./tasks/P9-002-webhook-sink-consumer-v1.md) — merged in `b1cf534`
- [P9-003 Meta CAPI Consumer v1](./tasks/P9-003-meta-capi-consumer-v1.md) — merged in `c51bfce`
- [P9-007 Destination Delivery Records and DLQ Triage](./tasks/P9-007-destination-dlq-triage.md) — merged in `b908cd9`

### P10 Observability and Operations

- [P10-001 Observability Compose](./tasks/P10-001-observability-compose.md) — merged in `d5ab28f`
- [P10-002 Metrics Standardization](./tasks/P10-002-metrics-standardization.md) — merged in `f918b55`

### P11 Deployment, Security, and Data Lifecycle

- [P11-002 CI Workflow](./tasks/P11-002-ci-workflow.md) — merged in `28d6105`
- [P11-005 Backup and Retention Runbooks](./tasks/P11-005-backup-retention-runbooks.md) — merged in `618af87`
- [P11-006 Security Hardening — origin allow-list scaffold](./tasks/P11-006-security-hardening.md) — merged in `b8b9741` (partial salvage; superseded by P11-006b)
- [P11-006b Security Hardening — wire-up + HSTS + body-limit + OpenAPI 403](./tasks/P11-006b-security-hardening-completion.md) — merged in `a66631e` (partial; rate-limit deferred to P11-006c)
- [P11-006c Rate-Limit Module for the Ingester](./tasks/P11-006c-rate-limit-module.md) — merged in `3d6e236`
- [P11-001 Production Dockerfiles](./tasks/P11-001-production-dockerfiles.md) — merged in `9a5da8d`

### P12 Release Readiness

- [P12-001 SDK Handbook](./tasks/P12-001-sdk-handbook.md) — merged in `9d80fb7`
- [P12-002 API Docs and OpenAPI Publishing](./tasks/P12-002-api-docs-openapi.md) — merged in `b27d15e`
