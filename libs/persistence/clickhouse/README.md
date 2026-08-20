# @polaris/shared-clickhouse

The only sanctioned in-process path to ClickHouse for Polaris services and the
CLI. Wraps the official [`@clickhouse/client`](https://www.npmjs.com/package/@clickhouse/client)
package and exposes a role-aware surface that mirrors the database-level
grants defined in [`sql/clickhouse/roles/`](../../../sql/clickhouse/roles/).

See [`docs/architecture/07-clickhouse.md`](../../../docs/architecture/07-clickhouse.md)
for the full architecture and access-control rationale.

## Why this package

Services and CLI code MUST NOT import `@clickhouse/client` directly. A
workspace-level lint rule (added by P11-002 CI) enforces that. The helper
exposes a narrow, role-aware surface so:

- the `service` profile cannot read `analytics_raw` even by accident (the
  type system has no method that returns rows from it on that profile, and the
  underlying connection authenticates as `polaris_service` which has no
  `SELECT` grant on `analytics_raw`),
- the `operator` profile gets typed, dedupe-correct readers
  (`replay.argMaxByEventKey`, `replay.countDistinctEvents`) for
  `analytics_raw`,
- an explicit `operator.raw.query(...)` escape hatch exists for genuinely
  ad-hoc SQL and emits a metric + structured log line on every call so usage
  is observable.

## Profiles

```ts
import { createClickHouseClient } from "@polaris/shared-clickhouse";

// Service profile: ingester, processors, consumers, dashboard API,
// CLI inspection commands.
const service = createClickHouseClient({
  url: "http://localhost:8123",
  role: "service",
  credential: { username: "polaris_service", password: "..." },
});

await service.health.check();
await service.ingestLog.inspect({ projectId: "storefront", limit: 100 });
await service.projections.eventDailyCounts.read({
  projectId: "storefront",
  fromDate: "2026-05-01",
});

// Operator profile: replay/rebuild jobs, operator investigation.
const operator = createClickHouseClient({
  url: "http://localhost:8123",
  role: "operator",
  credential: { username: "polaris_operator", password: "..." },
  logger,
  metrics,
});

await operator.replay.argMaxByEventKey({
  projectId: "storefront",
  environment: "production",
  event: "checkout.completed",
  eventIds: ["..."],
});

// Escape hatch — emits a metric and a log line on every call.
await operator.raw.query("SELECT count() FROM polaris.analytics_raw SETTINGS final = 1", []);
```

## Rules the package enforces

1. **Role required at construction.** `createClickHouseClient` throws
   `ClickHouseConfigError` if `role` is not `"service"` or `"operator"`.
2. **Service profile has no `analytics_raw` reader.** TypeScript does not
   expose `replay` or `raw` on the service profile. The underlying role grants
   provide a second layer of enforcement.
3. **`FINAL` is never used internally.** Replay methods use `argMax(_, _version)`.
   `FINAL` only ever appears in caller-supplied SQL inside `operator.raw.query`.
4. **Escape hatch is observable.** `operator.raw.query` emits
   `polaris_clickhouse_operator_raw_query_total` and a structured log line
   with caller-supplied `reason`.

## Adding a new projection reader

1. Land the projection DDL under [`sql/clickhouse/projections/`](../../../sql/clickhouse/projections/)
   and its argMax MV under [`sql/clickhouse/materialized-views/`](../../../sql/clickhouse/materialized-views/).
2. Add the grant in [`sql/clickhouse/roles/01_grants.sql`](../../../sql/clickhouse/roles/01_grants.sql).
3. Add a typed reader under `src/projections/<projection_name>.ts` and re-export
   from `src/projections/index.ts`.
4. Add a unit test that pins the generated SQL shape.

The PR is the canonical place to document the projection's engine choice and
the query patterns it serves (per
[`docs/architecture/07-clickhouse.md`](../../../docs/architecture/07-clickhouse.md)
"Projection Tables / Engine Selection Methodology").

## Composition with other shared packages

Once `@polaris/shared-config`, `@polaris/shared-logger`, and
`@polaris/shared-secrets` land, services should construct the client like this:

```ts
import { loadConfig } from "@polaris/shared-config";
import { createLogger } from "@polaris/shared-logger";
import { getSecret } from "@polaris/shared-secrets";
import { createClickHouseClient } from "@polaris/shared-clickhouse";

const config = loadConfig();
const logger = createLogger({ service: "ingester" });
const credential = await getSecret(config.clickhouse.credentialRef);
const client = createClickHouseClient({
  url: config.clickhouse.url,
  role: config.clickhouse.role,
  credential,
  logger,
});
```

Until those packages land, the package accepts a small `Logger` interface and
a `MetricsRecorder` interface that match the upstream contracts so adopting
services do not need to wait.
