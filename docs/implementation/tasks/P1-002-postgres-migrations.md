# P1-002: PostgreSQL Migration Scaffold

Status: Backlog

## Goal

Add SQL-first PostgreSQL migration scaffolding for runtime/control state.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Destinations](../../architecture/06-destinations.md)

## Dependencies

- P0-001
- P0-002
- P1-001

## Write Scope

Allowed:

```text
db/
migrations/
package.json
```

Forbidden:

```text
apps/
packages/shared-schemas/
processors/
consumers/
```

## Implementation Notes

- Use SQL-first migrations.
- Default to dbmate unless implementation-time review finds a better maintained choice.
- Start with minimal runtime/control tables only.
- Do not store event schemas or destination mappings in PostgreSQL.

Initial table areas:

```text
api_keys
sources runtime state
destination_instances
processor_runs
replay_jobs
delivery_records
audit_records
```

## Acceptance Criteria

- [ ] Migration tool wiring exists.
- [ ] Initial SQL migration exists.
- [ ] Migrations do not encode semantic event schemas or mapping logic.
- [ ] README or script documents how to run migrations locally.

## Checks

Run where possible:

```text
pnpm db:migrate
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

