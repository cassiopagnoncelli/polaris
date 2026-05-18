# ClickHouse Rebuilds

This page documents the controlled rebuild workflow for Polaris's
analytical ClickHouse projections. The shipping commands live in the
`polaris` CLI under `polaris clickhouse-rebuild`; rebuild jobs land
in the `clickhouse_rebuild_jobs` PostgreSQL table; the dry-run
planner lives in `@polaris/shared-clickhouse/rebuild`.

## Why this is a planned workflow

A Polaris projection (`polaris.event_daily_counts`, future projections
under `sql/clickhouse/projections/`) is a **denormalized OLAP table**
populated by an argMax-based materialized view reading from
`polaris.analytics_raw`. See
[`docs/architecture/07-clickhouse.md`](../architecture/07-clickhouse.md)
"Projection Tables".

When a projection becomes wrong — a bug in the MV's transform, a late
schema correction in upstream events, a partition that landed during a
bad processor revision — the supported fix path is a **rebuild job**:

1. Operator runs `polaris clickhouse-rebuild plan --projection <name>`
   to pre-flight: which partitions would be touched, how many rows,
   are there known gaps in `system.parts`.
2. Operator runs `polaris clickhouse-rebuild create --projection
   <name> --dry-run --reason "..."`. The CLI persists a `dry_run`
   row in `clickhouse_rebuild_jobs` carrying the planner's
   estimates, writes the matching `audit_records` row in the same
   transaction, and exits 0.
3. Operator promotes the dry-run to a live rebuild by re-running
   without `--dry-run`. The executor reads the row, advances `status`
   through `pending → running → completed | failed`, and stamps
   `error_class`/`error_message` if it fails.

### What hand-rolled fix paths break

Operators are tempted to write `ALTER TABLE … DROP PARTITION` followed
by `INSERT INTO polaris.<projection> SELECT … FROM
polaris.analytics_raw …` directly through `clickhouse-client`. This
**is not the supported fix path** for three reasons:

1. **Audit story breaks.** There is no row in `clickhouse_rebuild_jobs`
   recording who ran the rebuild, what range it covered, or why. A
   future incident review has no context.
2. **Kafka Engine consumers race.** The same partition that the
   operator just dropped is in the live ingest path —
   `analytics.events` → `analytics_events_queue` (Kafka Engine) →
   `analytics_raw` is always running. A drop+reinsert without
   coordinating with the runtime can re-introduce duplicates the
   ReplacingMergeTree won't notice until a merge happens. The rebuild
   workflow's executor (deferred) will run the argMax repopulation
   in a transactional partition-by-partition shape that survives
   concurrent ingest; ad-hoc SQL doesn't.
3. **Cross-replica inconsistency.** Hand-rolled `DROP PARTITION` is
   local to one replica unless the operator remembered to add `ON
   CLUSTER '{cluster}'`. The rebuild workflow always targets the
   logical projection through the same DDL macros the schema uses,
   so cross-replica state stays consistent.

Operators DO use those same primitives — `TRUNCATE TABLE`, `DROP
PARTITION`, `INSERT INTO … SELECT FROM polaris.analytics_raw` — but
through the executor's driver, which routes every call through the
operator escape hatch (`raw.query`) so each one carries a `caller` +
`reason` audit pair logged at `info` and counted in the
`polaris_clickhouse_operator_raw_query_total` metric.

## The closed set of rebuildable projections

The rebuild planner accepts a closed set of projection names. Each
maps to a DDL file under `sql/clickhouse/projections/` and a feeder
MV under `sql/clickhouse/materialized-views/`. As of P7-005:

| `--projection`         | DDL file                                            | Engine             |
| ---------------------- | --------------------------------------------------- | ------------------ |
| `event_daily_counts`   | `sql/clickhouse/projections/40_event_daily_counts.sql` | SummingMergeTree   |

The canonical list of closed-set names lives in
[`packages/shared-clickhouse/src/rebuild/projections.ts`](../../packages/shared-clickhouse/src/rebuild/projections.ts).
Adding a projection is a **four-step process**:

1. Land the DDL under `sql/clickhouse/projections/`.
2. Land the argMax-based MV under `sql/clickhouse/materialized-views/`.
3. Add the SELECT grant in `sql/clickhouse/roles/01_grants.sql`.
4. Append a row to `REBUILDABLE_CLICKHOUSE_PROJECTIONS`.

The `clickhouse-rebuild-commands` test asserts every registry entry
resolves to a real SQL file, so step 4 cannot drift from steps 1-2.

## Dry-run-first posture

Every real rebuild starts from a dry-run plan an operator has
reviewed. The dry-run is the contract the future executor will
consume — running `plan` (or `create --dry-run`) is not a separate
step from the rebuild, it's the **first** step.

The planner is read-only. It runs ONE ClickHouse query — a SELECT
against `system.parts` — to estimate partitions and row counts. It
never writes to ClickHouse and never touches the target projection
or `analytics_raw`. This makes `plan` and `create --dry-run` safe to
run against production at any time.

The planner emits a closed set of rejection codes; scripts can grep
for them in the CLI's error output:

| Rejection code            | When fired                                                                  |
| ------------------------- | --------------------------------------------------------------------------- |
| `unknown_projection`      | `--projection` is not in the closed set (see registry above).               |
| `invalid_range`           | `--from`/`--to` malformed, partially supplied, or `--to < --from`.          |
| `range_empty`             | `--from == --to` (zero-width window selects nothing).                       |
| `clickhouse_unreachable`  | The planner can't read `system.parts`. Distinct from "wrong name".          |

The CLI surfaces these as `clickhouse_rebuild_rejected:<code>` in
the exit-code message so `grep` is reliable in CI.

## The execute path

`polaris clickhouse-rebuild create <projection> --reason "..."`
(without `--dry-run`) persists a `pending` row + audit row and then
hands the row to the executor (`executeClickhouseRebuild` in
`packages/shared-clickhouse/src/rebuild/executor.ts`) which walks
the state machine to a terminal status:

```
pending → running → completed
                 ↘ failed
       (aborted by a sibling operator before markRunning succeeds)
```

The executor is pure orchestration over two injected adapters:

- A **store** (Kysely-backed in production) that performs the
  `pending → running` / `running → completed` / `running → failed`
  transitions as guarded single-row UPDATEs (`WHERE status =
  '<previous>'`). The migration's
  `clickhouse_rebuild_jobs_error_pair` and
  `clickhouse_rebuild_jobs_error_status_consistent` CHECK
  constraints enforce the both-set/both-null and "non-null
  error_class iff status='failed'" invariants on the row.

- A **driver** (`createClickhouseRebuildDriver` in
  `packages/shared-clickhouse/src/rebuild/driver.ts`) that wraps the
  operator escape hatch and issues, in order:

  1. `clearSlice` — `TRUNCATE TABLE` on a full-table rebuild, or
     `ALTER TABLE … DROP PARTITION {partition:String}` once per
     partition on a ranged rebuild. Both are synchronous in
     ClickHouse, so no mutation polling is needed.

  2. `rebuildPartition` — `INSERT INTO <projection> <select>` where
     `<select>` is the SELECT body checked in under the projection's
     `rebuildSelectFile` slot, with `{partition:String}` bound as a
     query parameter. The driver does not interpolate the partition
     label into the SQL.

Every raw SQL call carries `caller="polaris-cli/clickhouse-rebuild"`
and `reason` stamped with the job id, so the
`polaris_clickhouse_operator_raw_query_total` metric and the
operator audit log have a one-to-many breakdown from job id to
clearSlice + INSERT calls.

The exit-code contract:

| Outcome                    | Exit code              |
| -------------------------- | ---------------------- |
| `completed`                | 0 (`Ok`)               |
| `failed`                   | 1 (`GenericFailure`)   |
| `aborted` (peer-aborted)   | 1 (`GenericFailure`)   |

A common script pattern works as expected:

```bash
polaris clickhouse-rebuild create --projection event_daily_counts \
  --reason "ticket-1234" || exit 1
echo "rebuild complete"
```

### Required env

The non-dry-run path uses the operator profile, so the CLI must see:

```
POLARIS_CLICKHOUSE_URL
POLARIS_CLICKHOUSE_DATABASE
POLARIS_CLICKHOUSE_OPERATOR_USER
POLARIS_CLICKHOUSE_OPERATOR_PASSWORD
```

Missing operator credentials fail with `ConfigError` (exit code 3)
before the executor runs — no row gets stamped, no SQL gets issued.

The `--dry-run` path (and `polaris clickhouse-rebuild plan`) also
need the operator profile: the planner reads `system.parts` for the
partition estimate through the same `raw.query` escape hatch. The
adapter lives in
[`packages/shared-clickhouse/src/rebuild/parts-reader.ts`](../../packages/shared-clickhouse/src/rebuild/parts-reader.ts);
the CLI wires it via the shared
[`connectOperatorClickHouse`](../../apps/polaris-cli/src/clickhouse/connect.ts)
helper that both `defaultDriver` and `defaultReadPartitions` use.
Plan / dry-run runs hit the same env-validation failure when
operator credentials are absent.

### Adding a new projection

When extending `REBUILDABLE_CLICKHOUSE_PROJECTIONS`, the four-step
process now includes a fifth file: the rebuild SELECT.

1. DDL under `sql/clickhouse/projections/40_<name>.sql`.
2. Feeder MV under `sql/clickhouse/materialized-views/41_mv_…_to_<name>.sql`.
3. Rebuild SELECT under `sql/clickhouse/projections/40_<name>_rebuild.sql`
   — the SELECT body the MV uses, plus
   `WHERE _partition_id = {partition:String}` and one terminating
   semicolon.
4. SELECT grant in `sql/clickhouse/roles/01_grants.sql`.
5. Append a `ClickhouseProjectionDescriptor` to
   `REBUILDABLE_CLICKHOUSE_PROJECTIONS` with all four paths.

The `rebuildable projection registry matches the on-disk SQL` test
in `apps/polaris-cli/test/clickhouse-rebuild-commands.test.ts`
asserts every descriptor's `rebuildSelectFile` exists on disk and
mentions `{partition:String}`. Adding a projection without the
rebuild SELECT fails the test suite.

The rebuild SELECT must never use the `FINAL` keyword. The argMax
pattern is the project's one sanctioned dedupe approach.

## Rolling back a faulty rebuild plan

A dry-run row is a plan, not a mutation. Rolling back is mechanical:

- **The plan was wrong (operator misjudged the range).** Run
  `polaris clickhouse-rebuild abort <id> --reason "..."` to flip the
  row's status to `aborted`. The planner is idempotent — it doesn't
  write to ClickHouse — so the only state to undo is the PostgreSQL
  row, and `aborted` documents the operator's "I considered this and
  decided against it" decision. The audit trail keeps the row;
  there's no `DELETE FROM clickhouse_rebuild_jobs`.

- **The plan was right but the executor failed partway.** The
  executor sets `status='failed'` with `error_class` +
  `error_message` describing the failure. Re-run `create --dry-run`
  to get a fresh plan against the current state of `analytics_raw`,
  review, then re-run without `--dry-run` to retry. Failed rows are
  immutable from the CLI — they are the audit trail of "this attempt
  failed", not a state to mutate.

- **The plan was right but ClickHouse was unreachable when the
  planner tried to estimate.** The CLI surfaces
  `clickhouse_rebuild_rejected:clickhouse_unreachable` and no row is
  persisted. Investigate the ClickHouse outage and retry.

## CLI reference

### `polaris clickhouse-rebuild plan`

Read-only. Renders the dry-run plan without persisting anything.

```bash
polaris clickhouse-rebuild plan \
  --projection event_daily_counts \
  --from 2026-05-01T00:00:00Z \
  --to   2026-05-15T00:00:00Z
```

Pass `--output json` for the full machine-readable plan; the human
form is a digest.

### `polaris clickhouse-rebuild create --dry-run`

Mutating (records the operator's intent + planner's estimate).
Persists one row in `clickhouse_rebuild_jobs` with
`status='dry_run'`, writes the audit row in the SAME transaction,
exits 0.

```bash
polaris clickhouse-rebuild create \
  --projection event_daily_counts \
  --dry-run \
  --reason "ticket-1234 — recompute after schema fix lands"
```

### `polaris clickhouse-rebuild create` (no `--dry-run`)

Persists a row with `status='pending'`, writes the audit row, then
hands the row to the executor. The executor advances the row through
`running → completed | failed` and stamps the outcome. Exits 0 on
`completed`, 1 on `failed` / `aborted`. Requires operator
ClickHouse env (see [The execute path](#the-execute-path) →
"Required env").

### `polaris clickhouse-rebuild list`

Read-only. Newest first. Filter by `--status`, `--projection`,
`--limit`.

### `polaris clickhouse-rebuild show <id>`

Read-only. Full row including planner estimates and any
`error_class` / `error_message` the executor stamped on failure.

### `polaris clickhouse-rebuild abort <id> --reason "..."`

Mutating. Flips an abortable row (`pending`, `planning`, or
`dry_run`) to `aborted`, stamps `completed_at` + `updated_at`,
writes the audit row in the same transaction. Idempotent on
terminal rows.

## Related architecture

- [Architecture: ClickHouse](../architecture/07-clickhouse.md) —
  the projection model, the argMax pattern, the access roles, and
  the "Replay and Rebuild" section that mandates this workflow.
- [Architecture: Processors and Replay](../architecture/05-processors-and-replay.md) —
  the replay control plane this CLI is intentionally modelled on.
- [Architecture: Control plane](../architecture/02-control-plane.md) —
  why PostgreSQL holds runtime/control state and why the audit row
  ships in the same transaction as the mutation.
