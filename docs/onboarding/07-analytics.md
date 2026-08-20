# Phase 7 — View it in analytics

Polaris feeds ClickHouse through `async/warehouse/clickhouse-sink`. The flow is:

```text
RabbitMQ resolved.events
  -> ClickHouse ingestion interface table (analytics_events_queue)
  -> Materialized view
  -> analytics_raw (immutable, append-only, deduped on read)
  -> projection tables (e.g. event_daily_counts) read directly
```

`resolved.events` is the topic the ClickHouse sink subscribes to. The full
schema and dedupe rules are in
[Architecture / ClickHouse](../architecture/07-clickhouse.md). Two rules
matter here:

1. **`analytics_raw` is never queried without explicit dedupe.** Use the
   `argMax(col, _version)` pattern (the operator role does this through
   `@polaris/persistence-clickhouse` helpers).
2. **Projection tables are the normal read path.** They are pre-deduped
   and partitioned for the access patterns the platform supports.

## Roles

ClickHouse has two roles in v1:

| Role | Who uses it | Can read | DDL? |
|---|---|---|---|
| `polaris_service` | Ingester, processors, consumers, future dashboard API, CLI inspection commands. | Projection tables + `analytics_ingest_log`. | No |
| `polaris_operator` | Replay/rebuild jobs, ad-hoc investigation, CLI operator commands. | All of the above plus `analytics_raw`. | Yes |

Local dev passwords are documented in [Getting Started / Querying
ClickHouse](../development/getting-started.md#querying-clickhouse) and are
`polaris_service` / `polaris_operator` respectively — these are **not
secrets**, they exist so role-aware code paths work locally.

## Step 7.1 — Inspect a projection table

The bread-and-butter operator workflow uses `clickhouse-client` against the
service role. Replace the host/port with the ClickHouse you actually have
access to:

```bash
clickhouse-client \
  --host 127.0.0.1 --port 9000 \
  --user polaris_service --password polaris_service \
  --query "
SELECT *
FROM polaris.event_daily_counts
WHERE project_id = 'your_project'
  AND environment = 'production'
ORDER BY day DESC, event_name
LIMIT 20
"
```

For a fresh project with very recent traffic, you may need the operator
role to query `analytics_raw` directly with the dedupe pattern. Examples
live in [Getting Started / Querying ClickHouse](../development/getting-started.md#querying-clickhouse).

## Step 7.2 — Confirm your event via the shared client

In-process code (services, CLI commands you write, dashboards) **must**
go through `@polaris/persistence-clickhouse`. The workspace-wide lint blocks
`import "@clickhouse/client"` directly because the helper enforces dedupe
and the role-aware grant model.

```ts
import { createClickHouseClient } from "@polaris/persistence-clickhouse";

const service = createClickHouseClient({
  url: "http://localhost:8123",
  role: "service",
  credential: { username: "polaris_service", password: "polaris_service" },
});

const rows = await service.projections.eventDailyCounts.read({
  projectId: "your_project",
  environment: "production",
  fromDate: "2026-05-01",
  limit: 20,
});

await service.close();
```

For replay-grade queries that need raw events:

```ts
const operator = createClickHouseClient({
  url: "http://localhost:8123",
  role: "operator",
  credential: { username: "polaris_operator", password: "polaris_operator" },
});

const events = await operator.replay.argMaxByEventKey({
  projectId: "your_project",
  environment: "production",
  event: "checkout.started",
  eventIds: ["018f1b9e-...-001", "018f1b9e-...-002"],
});
```

Architectural rationale: [ClickHouse / Service Roles](../architecture/07-clickhouse.md).

## Ad-hoc investigation

Genuinely one-off operator SQL (counting events for an investigation,
schema exploration, a forensic count) runs through `clickhouse-client`
directly under the operator role. It is reviewed at use-time, not
pre-committed; the connection log leaves a trail. This is documented as
the supported escape hatch in
[Architecture / ClickHouse](../architecture/07-clickhouse.md).

## What is NOT supported

- **Querying `analytics_events_queue` directly.** It is a `Null`
  engine — a SELECT returns nothing at all, which during an incident
  reads as "no data ingested" and sends you down the wrong path.
- **Querying `analytics_raw` without the `argMax(col, _version)` dedupe
  pattern.** Replays write duplicate rows by design; the dedupe pattern
  is how reads stay correct.
- **DDL from anything except the operator role's migration path.** The
  migrations under [`db/clickhouse/`](../../db/clickhouse/) are the only
  sanctioned DDL source.

## Done when

- A `SELECT` against `polaris.event_daily_counts` for your `(project_id,
  environment)` returns rows that include your event name and the day you
  produced events on.
- Or: an in-process query through
  `service.projections.eventDailyCounts.read(...)` returned matching
  rows.

## Next

[Phase 8 — Request destination enablement](./08-destinations.md) (if your
events need to flow to a vendor pipeline). Otherwise, [Phase 9](./09-support-and-escalation.md)
and you are done.
