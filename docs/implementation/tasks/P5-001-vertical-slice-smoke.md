# P5-001: Vertical Slice Smoke Test

Status: Ready

## Goal

Add a smoke test or script proving one event can travel through the first vertical slice.

## Required Reading

- [Architecture Overview](../../architecture/00-overview.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [ClickHouse](../../architecture/07-clickhouse.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P1-001
- P2-003
- P3-001 or P3-003
- P4-001
- P4-002

## Write Scope

Allowed:

```text
scripts/
tests/
package.json
docs/implementation/
```

Forbidden:

```text
architecture-changing edits outside docs/implementation/
```

## Implementation Notes

The smoke path should prove:

```text
SDK or test client
  -> ingester
  -> raw.events
  -> analytics processor
  -> analytics.events
  -> ClickHouse
  -> basic query
```

If a fully automated test is not yet feasible, create the closest repeatable script and document the gaps.

## Acceptance Criteria

- [ ] Repeatable command exists.
- [ ] It sends one governed event.
- [ ] It verifies event acceptance by ingester.
- [ ] It verifies downstream presence or documents the missing integration step.
- [ ] Output is human-readable.

## Checks

Run where possible:

```text
pnpm smoke:vertical
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

