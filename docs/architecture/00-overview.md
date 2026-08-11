# Architecture Overview

## Product Boundary

Polaris is an internal multi-project event infrastructure platform. It is not designed for external customers, commercial multi-tenancy, or billing-grade tenant isolation.

The platform must support multiple internal projects, products, applications, and business domains. `project_id` is first-class across events, schemas, sources, destinations, analytics, replay, and operations.

`project_id` is an operational scoping device, not a security perimeter. Cross-project read access within the organization is allowed by design. Project boundaries shape partition keys, retention defaults, runtime configuration, audit context, and destination instances; they do not enforce isolation against insider access. Anyone with operator access to Polaris can read any project's events. Producer-side access (write keys) is scoped per project/environment/source. Consumer-side access is trusted-operator until a future RBAC layer exists.

## Platform Responsibilities

Polaris provides:

- canonical event ingestion
- immutable raw event transport through RabbitMQ
- strict event contract validation
- downstream processing and enrichment
- identity resolution
- attribution and analytics event production
- destination delivery
- ClickHouse analytical ingestion
- replay control
- operational observability

## Core Data Path

```text
SDKs / Producers
    |
    v
Ingester API
    |
    v
RabbitMQ: raw.events
    |
    v
Versioned processors
    |
    v
RabbitMQ: identity.events / enriched.events / attribution.events / analytics.events
    |
    +--> Destination consumers
    |
    +--> clickhouse-sink -> persisted analytical tables
```

## Primary Stack

```text
Node.js + TypeScript      services, SDKs, processors, consumers
Fastify                   ingestion API
Zod                       HTTP and event schema validation
amqplib                   RabbitMQ AMQP 0-9-1 client
RabbitMQ                  event backbone
Redis                     short-lived dedupe, rate limit, cache, processor state
PostgreSQL                mutable runtime/control state
ClickHouse                analytical ingestion and OLAP storage
Prometheus/Grafana        metrics and dashboards
Loki                      log aggregation
OpenTelemetry             tracing hooks
```

## Architectural Principles

- RabbitMQ is the canonical event backbone.
- Raw events are immutable and append-only.
- Ingestion performs validation and publication, not enrichment.
- Enrichment, identity resolution, attribution, and destination delivery happen downstream.
- Semantic contracts live in files and code.
- PostgreSQL is database-light: it stores mutable runtime/control state only.
- Delivery is at-least-once.
- Consumers and processors must be idempotent. Ingress dedupe absorbs retry storms; it is not the canonical idempotency layer.
- Vendor semantics must never leak into canonical internal events.
- Replayability within the operational retention window is a primary architectural constraint. The window is bounded by `raw.events` retention until an object-storage raw archive exists.
- Everything important must be reconstructible or explainable from raw events, versioned code, run metadata, and replay records, within the operational retention window.

## MVP Build Sequence

Build a vertical slice first, with enough infrastructure to prove the full event path:

```text
registered event schema
minimal SDK sender
Fastify ingester
API key authentication
RabbitMQ raw.events
one simple processor
RabbitMQ analytics.events
clickhouse-sink
analytics ingest log
deduped analytics raw table
basic query
structured logs and metrics
```

This avoids spending too long on abstract control-plane machinery before the event path works end to end.

