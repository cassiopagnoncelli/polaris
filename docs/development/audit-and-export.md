# Audit and Export

This page documents the operator workflows that read the `audit_records`
table and export runtime/control-plane state out of PostgreSQL. The
shipping commands live in the `polaris` CLI; they are read-only and never
expose plaintext secrets.

## Why this exists

Polaris is file-heavy and database-light. Semantic platform truth (event
schemas, destination mappings, processor transform code) lives in versioned
code. Mutable runtime/control state (API keys, destinations, processor
activations, audit records) lives in PostgreSQL.

The `audit_records` table is the authoritative trail of state-changing CLI
commands. Every mutating command (P6-003 keys, P6-004 destinations,
P6-005 processors, future P6-007 operator tokens, future replays) writes
one audit row inside the SAME transaction as its mutation. If the mutation
rolls back, the audit row rolls back with it.

The `polaris audit` commands inspect that trail. The `polaris export`
commands export operational state for diff and review.

## `polaris audit` — read the trail

### `polaris audit list`

Lists recent audit records, filtered by any combination of:

| Flag              | Match                                                          |
| ----------------- | -------------------------------------------------------------- |
| `--actor <label>` | `actor_label` exact match (e.g. `cli`, `cli:alice@example`)    |
| `--target-type`   | `target_type` exact match (e.g. `destination`, `api_key`)      |
| `--target-id`     | `target_id` exact match                                        |
| `--action <verb>` | action verb (e.g. `destinations.disable`, `keys.revoke`)       |
| `--project <id>`  | `project_id` exact match                                       |
| `--env <env>`     | environment (`development` \| `staging` \| `production`)       |
| `--since <iso>`   | `created_at >=` (ISO 8601 UTC)                                 |
| `--until <iso>`   | `created_at <=` (ISO 8601 UTC)                                 |
| `--limit <n>`     | max rows returned (default 50, max 1000)                       |

Common shapes:

```bash
# What happened in production today?
polaris audit list --env production --since 2026-05-12T00:00:00Z

# What did this operator change?
polaris audit list --actor cli:alice@example.com --limit 200

# What is the full history of one destination?
polaris audit list --target-type destination --target-id polaris_dst_x
```

Human output is one line per row; JSON output (`--output json`) includes
the full `before`/`after` JSON snapshots.

### `polaris audit show <audit_id>`

Returns one full audit record including `before`/`after` snapshots and any
operator-supplied `reason`. Use after `audit list` finds the row you want.

```bash
polaris audit show 01923456-7890-7000-8000-000000000001
```

## `polaris export` — dump operational state

Every export command emits JSON. Human output is the same pretty-printed
JSON the JSON renderer emits — exports are pipeline material, not
operator-facing one-liners.

### `polaris export sources --project <id> --env <env>`

Exports the materialized `sources` rows for one (project, env). Source
declarations are file-backed (`catalog/sources/<project>/<source>.yaml`);
this export reads what's actually in PostgreSQL so you can diff runtime
against catalog.

```bash
polaris export sources --project storefront --env production > sources.json
```

### `polaris export api-keys --project <id> --env <env>`

**Never includes the argon2id `hash` column or the on-wire plaintext
token.** The export shape is a strict allowlist of metadata fields:

```json
{
  "project_id": "...",
  "environment": "...",
  "count": 1,
  "api_keys": [
    {
      "api_key_id": "polaris_ak_...",
      "project_id": "...",
      "environment": "...",
      "source_id": "...",
      "source_type": "web",
      "status": "active",
      "hash_algorithm": "argon2id",
      "created_at": "...",
      "revoked_at": null,
      "last_used_at": null
    }
  ]
}
```

Use this export for:

- Auditing which keys exist in which (project, env)
- Diffing between environments after a key rotation
- Confirming a revocation propagated to PostgreSQL

### `polaris export destinations --project <id> --env <env>`

Emits destination instance rows. Each row carries the `secret_ref`
**literal** (e.g. `env:META_CAPI_TOKEN_STOREFRONT_PROD`,
`secret_manager:polaris/production/.../meta-capi`). The CLI never resolves
the secret value at export time (or anywhere else outside the destination
consumer runtime); the reference itself names where the secret lives, not
what it is.

```bash
polaris export destinations --project storefront --env production
```

Mapping semantics (event-to-vendor field maps) are NOT in the export —
they live in `consumers/<vendor>/v<n>/mappers/` as versioned code. The
schema has nowhere to store them, and the export shape carries only
operational/runtime fields.

### `polaris export audit --since <iso> --until <iso> [--format json|ndjson]`

Bulk export of audit rows. Two formats:

- `json` (default): one envelope document containing `filter`, `count`,
  and `audit_records`. Pretty-printed.
- `ndjson`: one JSON object per line, no envelope. Designed for piping
  into log aggregation (Loki, Grafana, Elasticsearch) and batch
  processors.

```bash
# Diff-friendly bulk dump
polaris export audit --since 2026-05-01T00:00:00Z --until 2026-05-13T00:00:00Z \
  > audit-2026-05.json

# Pipe straight into Loki
polaris export audit --since 2026-05-12T00:00:00Z --until 2026-05-13T00:00:00Z \
  --format ndjson | promtail-pipeline ...
```

The filter surface mirrors `polaris audit list` so you can preview with
`audit list` and re-run with the same flags through `export audit` once
the result set looks right. Default limit is 1000; max is 100000.

## What audit records contain

Every audit row carries:

| Column         | Notes                                                              |
| -------------- | ------------------------------------------------------------------ |
| `audit_id`     | UUIDv7 generated by the recorder                                   |
| `created_at`   | UTC timestamptz, set from `now()` by default                       |
| `actor_source` | `cli` in v1 (until P6-007 wires authenticated operator tokens)     |
| `actor_label`  | `cli` in v1, `cli:<email>` post-P6-007                             |
| `action`       | `<group>.<verb>` matching the CLI's `CommandDefinition.id`         |
| `target_type`  | The noun (`destination`, `processor_activation`, `api_key`, ...)   |
| `target_id`    | Canonical id of the row touched                                    |
| `project_id`   | NULL for cross-project actions                                     |
| `environment`  | NULL when not applicable                                           |
| `before`       | Pre-mutation operational snapshot (NULL for creates)               |
| `after`        | Post-mutation operational snapshot (NULL for hard deletes)         |
| `reason`       | Operator-supplied rationale (`--reason <text>` where supported)    |
| `request_id`   | Correlation id (= `audit_id` until the control-plane API arrives)  |

The `before`/`after` snapshots NEVER contain plaintext secrets. The
recorder is the choke point — callers pass JSON shapes that have already
been scrubbed of resolved-value fields. For destination rows, that means
the snapshot carries the `secret_ref` literal but never the resolved
value. For API keys, the snapshot carries metadata but never the argon2id
hash or the on-wire plaintext.

## Indexes (and the queries they support)

The migration ships three indexes:

```text
audit_records_target_idx       (target_type, target_id, created_at DESC)
audit_records_project_env_idx  (project_id,  environment, created_at DESC)
audit_records_actor_idx        (actor_label, created_at DESC)
```

They cover the three most common audit queries:

1. "What happened to this row?" — `--target-type X --target-id Y`
2. "What changed in this project recently?" — `--project X --env Y --since Z`
3. "What did this operator do?" — `--actor X`

`created_at DESC` is the secondary key on all three so the default
"recent first" ordering is index-supported without an explicit sort step.

## Cross-cut: the recorder and existing commands

The audit recorder lives in `apps/polaris-cli/src/audit/recorder.ts`. It
exposes one entry point:

```ts
createAuditRecorder(db, { generateId?, now? }) -> AuditRecorder
recordAudit({ actorSource?, actorLabel, action, targetType, targetId, ... })
```

Every mutating P6-* command calls the recorder inside the same Kysely
transaction as its mutation:

- `polaris keys create`     -> `keys.create` audit row (after-only snapshot)
- `polaris keys revoke`     -> `keys.revoke` audit row (before+after)
- `polaris keys rotate`     -> two rows: `keys.rotate.issue` + `keys.rotate.revoke`
- `polaris destinations enable`  -> `destinations.enable` audit row
- `polaris destinations disable` -> `destinations.disable` audit row (with reason)
- `polaris processors enable`    -> `processors.enable` audit row
- `polaris processors disable`   -> `processors.disable` audit row

Idempotent re-runs (`enable on already-active`, `disable on already-disabled`,
etc.) skip the recorder. The CLI only writes an audit row when a real
transition lands. Operator-side filtering — "show me successful state
changes" — gets the right shape for free.

## Future tasks

- P6-007 (operator tokens + mutation gate): wires `cli_token` into the
  recorder so `actor_source` is `cli` and `actor_label` is `cli:<email>`.
- P7 (replays): replay jobs write audit rows on plan / approve / execute.
- P9 (destination consumers): delivery records live in their own table,
  but operator actions against them (pause, resume, retry) write here.
- P11 (production secret provider): rotations of the underlying secret
  store may write `migration` or `system` actor-source rows.
