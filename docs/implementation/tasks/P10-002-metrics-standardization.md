# P10-002: Metrics Standardization

Status: Backlog

## Goal

Standardize Prometheus metrics helpers and labels across services, processors, and consumers.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P0-005
- P8-001
- P9-001

## Write Scope

Allowed:

```text
packages/shared-metrics/
packages/shared-service/
packages/shared-processor/
packages/shared-destinations/
```

Forbidden:

```text
business logic in apps/processors/consumers unless needed to wire existing metrics helpers
```

## Implementation Notes

Standard labels should include applicable fields:

```text
project_id
environment
source_id
topic
processor_name
processor_version
consumer_name
consumer_version
destination_id
```

Avoid high-cardinality labels like raw `event_id`.

## Acceptance Criteria

- [ ] Shared metrics package exists or service bootstrap exposes metrics helpers.
- [ ] Standard metric naming conventions are documented.
- [ ] High-cardinality label warning is documented.
- [ ] Tests cover metric registration where practical.

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
Commands run:
Checks passed:
Known gaps:
```

