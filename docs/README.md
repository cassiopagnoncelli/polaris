# Polaris Documentation

Polaris is an internal multi-project event infrastructure platform. It is designed for attribution, analytics, activation, and operational intelligence inside one organization.

Redpanda is the immutable streaming backbone. Polaris is the platform built around it.

## Core Architecture

```text
SDKs / producers
  -> Ingester API
  -> Redpanda raw.events
  -> versioned processors
  -> Redpanda derived topics
  -> destination consumers
  -> ClickHouse analytical storage
```

## Reading Order

- [Architecture Overview](./architecture/00-overview.md)
- [Event Contract](./architecture/01-event-contract.md)
- [Control Plane](./architecture/02-control-plane.md)
- [Redpanda Topics](./architecture/03-redpanda-topics.md)
- [Ingestion and SDKs](./architecture/04-ingestion-and-sdks.md)
- [Processors and Replay](./architecture/05-processors-and-replay.md)
- [Destinations](./architecture/06-destinations.md)
- [ClickHouse](./architecture/07-clickhouse.md)
- [Observability and Operations](./architecture/08-observability-and-operations.md)
- [Engineering Standards](./architecture/09-engineering-standards.md)
- [Architecture Decision Ledger](./adr/0001-architecture-decisions.md)
- [Engineering Decision Ledger](./adr/0002-engineering-decisions.md)
- [Codex Instructions](./instructions/codex.md)

## Non-Negotiable Rules

- Polaris is internal infrastructure, not an external multi-tenant SaaS product.
- `project_id` is first-class and required.
- `environment` is stamped by the ingester from the API key, not accepted from producers.
- Raw events are immutable, append-only, and replayable.
- Ingestion stays thin.
- Event schemas and destination mappings are semantic code, not mutable database data.
- PostgreSQL stores mutable runtime/control state, not semantic platform truth.
- SDKs are transport and identity helpers, not analytics engines.
- Processors and consumers are independent and versioned.
- Destination consumers are protocol translators.
- ClickHouse consumes `analytics.events` through Kafka Engine and persists rows before querying.
- Replayability is a primary architectural constraint.
