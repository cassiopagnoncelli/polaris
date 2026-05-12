# P6-006: Audit and Export CLI

Status: Review

## Goal

Implement audit inspection and export commands for runtime/control state.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Delivery Roadmap](../delivery-roadmap.md)

## Dependencies

- P6-001
- P6-002
- P6-003

## Write Scope

Allowed:

```text
apps/polaris-cli/
db/
migrations/
docs/development/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
```

## Implementation Notes

Commands shipped:

```text
polaris audit list                                                              # mutates: false
polaris audit show <audit_id>                                                   # mutates: false
polaris export sources --project <id> --env <env>                               # mutates: false
polaris export api-keys --project <id> --env <env>                              # mutates: false
polaris export destinations --project <id> --env <env>                          # mutates: false
polaris export audit --since <iso> --until <iso> [--format json|ndjson] [...]   # mutates: false
```

Plus:

- `db/migrations/20260512000007_create_audit_records.sql` — the `audit_records`
  table with three indexes (target, project_env, actor) ordered by
  `created_at DESC`.
- `apps/polaris-cli/src/audit/recorder.ts` — `createAuditRecorder(db, hooks)`
  returns an `AuditRecorder` bound to a Kysely client or transaction.
- `apps/polaris-cli/src/db/audit-records.ts` — typed `AuditRecordsTable`
  augmenting `@polaris/shared-db`'s `Database` interface, plus
  `insertAuditRecord` / `findAuditRecordById` / `listAuditRecords` helpers.
- Cross-cuts into existing P6-003/P6-004/P6-005 commands: every mutating
  store call (`keys.create`, `keys.revoke`, `keys.rotate`,
  `destinations.enable`, `destinations.disable`, `processors.enable`,
  `processors.disable`) now wraps UPDATE+audit INSERT in one Kysely
  transaction. Stderr "audit_records table is created by P6-006" TODO
  markers removed.
- Documentation: `docs/development/audit-and-export.md` covers the
  operator workflows.

Exports never include plaintext secrets: api-keys export omits `hash`
(repository SELECT doesn't carry the column; emit shape is a strict
allowlist), destinations export emits `secret_ref` literals only.

## Acceptance Criteria

- [x] Audit list/show commands exist.
- [x] Runtime export excludes secret values.
- [x] Export output is deterministic enough for review.
- [x] Tests cover secret redaction in exports.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  Created:
    db/migrations/20260512000007_create_audit_records.sql
    apps/polaris-cli/src/audit/recorder.ts
    apps/polaris-cli/src/db/audit-records.ts
    apps/polaris-cli/src/commands/audit/index.ts
    apps/polaris-cli/src/commands/audit/list.ts
    apps/polaris-cli/src/commands/audit/show.ts
    apps/polaris-cli/src/commands/export/index.ts
    apps/polaris-cli/src/commands/export/sources.ts
    apps/polaris-cli/src/commands/export/api-keys.ts
    apps/polaris-cli/src/commands/export/destinations.ts
    apps/polaris-cli/src/commands/export/audit.ts
    apps/polaris-cli/test/audit-export-commands.test.ts
    apps/polaris-cli/test/audit-recorder.test.ts
    docs/development/audit-and-export.md
  Modified (cross-cut: wire audit recorder into transactions):
    apps/polaris-cli/src/commands/keys/create.ts
    apps/polaris-cli/src/commands/keys/revoke.ts
    apps/polaris-cli/src/commands/keys/rotate.ts
    apps/polaris-cli/src/commands/destinations/enable.ts
    apps/polaris-cli/src/commands/destinations/disable.ts
    apps/polaris-cli/src/commands/processors/enable.ts
    apps/polaris-cli/src/commands/processors/disable.ts
    apps/polaris-cli/src/commands/index.ts
    apps/polaris-cli/src/db/index.ts
    apps/polaris-cli/src/index.ts
    apps/polaris-cli/test/keys-commands.test.ts
    apps/polaris-cli/test/destinations-commands.test.ts
    apps/polaris-cli/test/processors-commands.test.ts

Commands run:
  pnpm install --frozen-lockfile
  pnpm -r --if-present build
  pnpm --filter @polaris/polaris-cli typecheck     # OK
  pnpm --filter @polaris/polaris-cli lint          # OK
  pnpm --filter @polaris/polaris-cli test          # 190/190 pass
  pnpm typecheck                                   # OK across 14 packages
  pnpm lint                                        # OK + clickhouse-imports gate
  pnpm test                                        # 972/972 tests + 46 scripts tests pass

Checks passed:
  - typecheck (workspace-wide)
  - lint (workspace-wide, including the clickhouse-import gate)
  - unit tests (972 workspace + 46 scripts; 31 new tests for P6-006)
  - migration shape inspection (audit_records columns + indexes + no secret-shaped columns)
  - recorder validation (actor source, actor label, action, target, reason length)
  - secret-redaction asserts on export api-keys (no `hash` substring, no on-wire shape)
  - secret-redaction asserts on export destinations (emits `secret_ref` literal only)
  - integration assert: destinations.disable runs the recorder with the canonical payload;
    idempotent re-runs skip the recorder.

Known gaps:
  - Integration test against a live PostgreSQL container is not part of this
    task's scope (matches the P6-* pattern). The recorder is exercised end-to-end
    against an in-memory store; the real schema is asserted by the migration-shape
    test reading the SQL file.
  - `cli_token` actor source is wired into the audit row shape, but the recorder
    receives `cli` as the actor label until P6-007 ships authenticated tokens.
  - The control-plane API (P6-000) is not yet shipped, so the `request_id` column
    defaults to the audit_id at write time. Once the API lands, it stamps a
    per-request correlation id and the CLI surfaces it through here.
```

