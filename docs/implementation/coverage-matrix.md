# Implementation Coverage Matrix

This matrix maps architecture areas to implementation task phases.

It is not a replacement for task cards. It is a quick way to see whether the delivery plan covers the architecture.

## Architecture Coverage

| Area | Primary Docs | Task Coverage |
| --- | --- | --- |
| Product boundary and principles | `00-overview.md` | P0-P5, P12 |
| Event envelope and schemas | `01-event-contract.md` | P0-006, P2-003, P12-002 |
| Experimental events | `01-event-contract.md` | P0-006, P2-003 |
| Sensitive-field guardrails | `01-event-contract.md`, `04-ingestion-and-sdks.md` | P2-003, P11-006 |
| Control-plane state | `02-control-plane.md` | P1-002, P6-* |
| API keys and sources | `02-control-plane.md` | P1-002, P2-002, P6-002, P6-003 |
| Secret references | `02-control-plane.md` | P0-008, P11-004 |
| Redpanda topics and partitioning | `03-redpanda-topics.md` | P0-007, P1-001, P2-003, P4-001 |
| Retry and DLQ topics | `03-redpanda-topics.md`, `06-destinations.md` | P4-001, P9-001, P9-007 |
| Ingester API | `04-ingestion-and-sdks.md` | P2-001, P2-002, P2-003 |
| SDK APIs and persistence | `10-sdk-standards.md` | P3-001, P3-002, P3-003, P12-001 |
| Processor versioning | `05-processors-and-replay.md` | P4-001, P8-001, P8-006 |
| Identity resolution | `05-processors-and-replay.md`, `10-sdk-standards.md` | P3-002, P8-002 |
| Sessionization | `05-processors-and-replay.md`, `10-sdk-standards.md` | P3-002, P8-003 |
| Replay control plane | `05-processors-and-replay.md` | P7-* |
| Destination mappings | `06-destinations.md` | P9-* |
| Destination delivery records | `06-destinations.md` | P1-002, P9-001, P9-007 |
| ClickHouse ingestion | `07-clickhouse.md` | P1-003, P4-002, P7-005 |
| Observability | `08-observability-and-operations.md` | P10-* |
| Local development | `08-observability-and-operations.md` | P1-001, P10-001, P5-002 |
| Engineering standards | `09-engineering-standards.md` | P0-001, P0-002, P11-002, P11-007 |
| Production deployment | `09-engineering-standards.md`, `11-production-readiness.md` | P11-* |
| Production secrets | `02-control-plane.md`, `11-production-readiness.md` | P0-008, P11-004 |
| Data lifecycle | `03-redpanda-topics.md`, `07-clickhouse.md`, `11-production-readiness.md` | P11-005 |
| Product release readiness | roadmap | P12-* |

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
