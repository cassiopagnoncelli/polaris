# Polaris Documentation

Polaris is an internal multi-project event infrastructure platform. It is designed for attribution, analytics, activation, and operational intelligence inside one organization.

RabbitMQ is the immutable streaming backbone. Polaris is the platform built around it.

## Core Architecture

```text
SDKs / producers
  -> Ingester API
  -> RabbitMQ raw.events
  -> versioned processors
  -> RabbitMQ derived topics
  -> destination consumers
  -> ClickHouse analytical storage
```

## Reading Order

- [Architecture Overview](./architecture/00-overview.md)
- [Event Contract](./architecture/01-event-contract.md)
- [Control Plane](./architecture/02-control-plane.md)
- [RabbitMQ Streams](./architecture/03-rabbitmq-streams.md)
- [Ingestion and SDKs](./architecture/04-ingestion-and-sdks.md)
- [Processors and Replay](./architecture/05-processors-and-replay.md)
- [Destinations](./architecture/06-destinations.md)
- [ClickHouse](./architecture/07-clickhouse.md)
- [Observability and Operations](./architecture/08-observability-and-operations.md)
- [Engineering Standards](./architecture/09-engineering-standards.md)
- [SDK Standards](./architecture/10-sdk-standards.md)
- [Production Readiness](./architecture/11-production-readiness.md)
- [Architecture Decision Ledger](../agents/architect/adr/0001-platform-architecture-ledger.md)
- [Engineering Decision Ledger](../agents/architect/adr/0002-engineering-standards-ledger.md)
- [SDK Decision Ledger](../agents/architect/adr/0003-sdk-standards-ledger.md)
- [Production Readiness Decision Ledger](../agents/architect/adr/0004-production-readiness-ledger.md)
- [Implementation Playbook](./implementation/README.md)
- [Implementation Kanban](../agents/pm/kanban) (file-backed board; run `python3 agents/pm/bin/cards.py report`)
- [Delivery Roadmap](./implementation/delivery-roadmap.md)
- [Coverage Matrix](./implementation/coverage-matrix.md)
- [Claude Instructions](./instructions/claude.md)

## Non-Negotiable Rules

- Polaris is internal infrastructure, not an external multi-tenant SaaS product. Cross-project visibility within the organization is allowed; project boundaries are an operational scoping device, not a security perimeter.
- `project_id` is first-class and required.
- `environment` is stamped by the ingester from the API key, not accepted from producers.
- Raw events are immutable, append-only, and replayable within the operational retention window.
- Ingestion stays thin.
- Event schemas and destination mappings are semantic code, not mutable database data.
- PostgreSQL stores mutable runtime/control state, not semantic platform truth.
- SDKs are transport and identity helpers, not analytics engines.
- Processors and consumers are independent and versioned.
- Destination consumers are vendor adapters: normalize, map, deliver. Mapping is the only stage that is purely protocol translation.
- ClickHouse is fed by `consumers/clickhouse-sink`, which consumes `analytics.events` and INSERTs batches; rows are persisted before querying. `analytics_raw` is never queried without explicit dedupe.
- Replayability within the operational retention window is a primary architectural constraint.
