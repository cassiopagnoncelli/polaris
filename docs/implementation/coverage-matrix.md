# Implementation Coverage Matrix

This matrix maps architecture areas to implementation task phases.

It is not a replacement for task cards. It is a quick way to see whether the delivery plan covers the architecture.

## Architecture Coverage

| Area | Primary Docs | Task Coverage |
| --- | --- | --- |
| Product boundary and principles | `00-overview.md` | P0-P5, P12 |
| Event envelope and schemas | `01-event-contract.md` | P0-006, P2-003, P12-002 |
| Schema evolution and deprecation | `01-event-contract.md` | P0-006, P2-003 |
| Experimental events | `01-event-contract.md` | P0-006, P2-003 |
| Forbidden-field policy | `01-event-contract.md` | P0-009, P2-003, P11-006 |
| Control-plane state | `02-control-plane.md` | P1-002, P6-* |
| Operator identity and audit actor | `02-control-plane.md`, `11-production-readiness.md` | P6-006, P6-007 |
| API keys and sources | `02-control-plane.md` | P1-002, P2-002, P6-002, P6-003 |
| Secret references | `02-control-plane.md` | P0-008, P11-004 |
| RabbitMQ topics and partitioning | `03-rabbitmq-streams.md` | P0-007, P1-001, P2-003, P4-001 |
| Topic isolation triggers and families | `03-rabbitmq-streams.md` | P0-007, P10-002, P11-008 |
| Per-project metrics labels | `03-rabbitmq-streams.md`, `08-observability-and-operations.md` | P10-002, P11-008 |
| Retry and DLQ topics | `03-rabbitmq-streams.md`, `06-destinations.md` | P4-001, P9-001, P9-007 |
| Ingester API | `04-ingestion-and-sdks.md` | P2-001, P2-002, P2-003 |
| Ingress dedupe (retry-storm absorber) | `04-ingestion-and-sdks.md` | P2-003 |
| SDK APIs and persistence | `10-sdk-standards.md` | P3-001, P3-002, P3-003, P12-001 |
| Processor versioning | `05-processors-and-replay.md` | P4-001, P8-001, P8-006 |
| Identity resolution | `05-processors-and-replay.md`, `10-sdk-standards.md` | P3-002, P8-002 |
| Sessionization | `05-processors-and-replay.md`, `10-sdk-standards.md` | P3-002, P8-003 |
| Replay control plane (window-bounded) | `05-processors-and-replay.md` | P7-* |
| Destination normalize / map / deliver | `06-destinations.md` | P9-000, P9-001, P9-003+ |
| Destination mappings | `06-destinations.md` | P9-* |
| Destination delivery records | `06-destinations.md` | P1-002, P9-001, P9-007 |
| ClickHouse ingestion | `07-clickhouse.md` | P1-003, P4-002, P7-005 |
| ClickHouse query patterns and Replicated engines | `07-clickhouse.md`, `11-production-readiness.md` | P1-003, P4-002 |
| ClickHouse access control (roles + helper) | `07-clickhouse.md`, `09-engineering-standards.md` | P0-010, P1-003, P11-002 |
| Observability | `08-observability-and-operations.md` | P10-* |
| Local development | `08-observability-and-operations.md` | P1-001, P10-001, P5-002 |
| Engineering standards | `09-engineering-standards.md` | P0-001, P0-002, P11-002, P11-007 |
| Production deployment | `09-engineering-standards.md`, `11-production-readiness.md` | P11-* |
| Per-project secrets (plaintext in PostgreSQL) | `02-control-plane.md`, `11-production-readiness.md` | P0-008, P11-004 (Vault, since removed) |
| Data lifecycle | `03-rabbitmq-streams.md`, `07-clickhouse.md`, `11-production-readiness.md` | P11-005 |
| Product release readiness | roadmap | P12-* |
| CLI access model and control-plane API | `02-control-plane.md` | P6-000, P6-001, P6-007 |
| Regional posture (single-region v1) | `11-production-readiness.md` | P11-001, P11-003 |
| Identity graph storage flexibility | `05-processors-and-replay.md` | P8-002 |
| GeoIP source (MaxMind GeoLite2) | `05-processors-and-replay.md` | P8-004 |
| SDK diagnostic events topic (opt-in) | `03-rabbitmq-streams.md`, `10-sdk-standards.md` | P0-007, P3-001, P3-003 |
| Customer deletion (deferred pattern) | `01-event-contract.md` | future |
| Backup and recovery RPO/RTO | `11-production-readiness.md` | P11-005 |
| Alert thresholds and SLOs (initial) | `11-production-readiness.md` | P10-005 |
| DLQ triage SLAs (initial) | `11-production-readiness.md` | P10-006 |
| API key rotation (no forced expiry v1) | `02-control-plane.md` | P6-003 |

## Known Intentional Gaps Before P11

These are not required for the first vertical slice, but are required before real internal production traffic:

- production secret provider
- backup/restore runbooks
- API origin/rate-limit hardening
- alert thresholds
- destination-specific credential rotation guidance
- release checklist
- internal onboarding docs

## Completion Rule

The implementation plan can be considered product-complete only after P12 acceptance criteria pass.

The implementation plan can be considered vertical-slice-complete after P5 acceptance criteria pass.
