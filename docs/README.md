# Polaris Documentation

Polaris is an internal multi-project event infrastructure platform. It is designed for attribution, analytics, activation, and operational intelligence inside one organization.

RabbitMQ is the immutable streaming backbone. Polaris is the platform built around it.

## Core Architecture

```text
SDKs / producers
  -> Ingester API
  -> RabbitMQ raw.events
  -> sync/identity/resolver   -> identified.events
  -> sync/enrichment/runtime  -> resolved.events
  -> sync/destinations        -> vendor APIs
  -> async/* off resolved.events, including clickhouse-sink
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
- [Implementation Playbook](./implementation/README.md)

The decision ledgers and the delivery board are **not in this repository**.
`agents/` is gitignored — it is an agent workspace, not a published tree — so
these were links to files nobody who clones Polaris can open, and are listed
here as paths rather than as links until somebody decides where they belong:

- `agents/architect/adr/0001-platform-architecture-ledger.md`
- `agents/architect/adr/0002-engineering-standards-ledger.md`
- `agents/architect/adr/0003-sdk-standards-ledger.md`
- `agents/architect/adr/0004-production-readiness-ledger.md`
- `agents/pm/kanban` — file-backed board; run `agents/pm/bin/pm report`

An architecture decision record is documentation of the kind this directory
exists to hold, so `docs/adr/` is the obvious home for the four ledgers.
Moving them makes them public, which is a call for whoever owns the repo.
- [Delivery Roadmap](./implementation/delivery-roadmap.md)
- [Coverage Matrix](./implementation/coverage-matrix.md)
- [Claude Instructions](./instructions/claude.md)

## Non-Negotiable Rules

- Polaris is internal infrastructure, not an external multi-tenant SaaS product. Cross-project visibility within the organization is allowed; project boundaries are an operational scoping device, not a security perimeter. Two consequences worth stating plainly, because both are easy to misread as isolation guarantees: **delivery routes on `project_id`** — an event from one project reaches only that project's destinations — but **the control-plane database holds every project's vendor credentials in plaintext**, so anyone who can read it can read all of them. The first is correctness; the second is the standing cost of storing per-project secrets there ([Control Plane — Secrets](./architecture/02-control-plane.md)).
- `project_id` is first-class and required.
- `environment` is stamped by the ingester from the API key, not accepted from producers.
- Raw events are immutable, append-only, and replayable within the operational retention window.
- Ingestion stays thin.
- Event schemas and destination mappings are semantic code, not mutable database data.
- PostgreSQL stores mutable runtime/control state, not semantic platform truth.
- SDKs are transport and identity helpers, not analytics engines.
- Processors and consumers are independent and versioned.
- Destination consumers are vendor adapters: normalize, map, deliver. Mapping is the only stage that is purely protocol translation.
- ClickHouse is fed by `async/warehouse/clickhouse-sink`, which consumes `resolved.events` and the derived families and INSERTs batches; rows are persisted before querying. `analytics_raw` is never queried without explicit dedupe.
- Replayability within the operational retention window is a primary architectural constraint.
