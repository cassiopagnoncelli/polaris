# P10-004: Loki Logging Pipeline

Status: Backlog

## Goal

Configure local Loki log ingestion for Polaris JSON logs without making Loki a service dependency.

## Required Reading

- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P10-001
- P0-004

## Write Scope

Allowed:

```text
infra/loki/
infra/otel/
docker-compose.observability.yml
docs/operations/
```

Forbidden:

```text
apps/
packages/
processors/
consumers/
```

## Implementation Notes

- Services continue to emit stdout JSON logs.
- Loki/collector pipeline is optional.
- Redaction remains in application logger config.

## Acceptance Criteria

- [ ] Loki config exists.
- [ ] Log collection path is documented.
- [ ] Services do not require Loki to start.
- [ ] Docs include example log query fields.

## Checks

Run where possible:

```text
docker compose -f docker-compose.yml -f docker-compose.observability.yml config
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

