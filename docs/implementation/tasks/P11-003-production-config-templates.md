# P11-003: Production Config Templates

Status: Backlog

## Goal

Add production-oriented runtime configuration templates without storing secrets.

## Required Reading

- [Control Plane](../../architecture/02-control-plane.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)

## Dependencies

- P0-003
- P11-001

## Write Scope

Allowed:

```text
config/
infra/
docs/deployment/
.env.example
```

Forbidden:

```text
plaintext secrets
semantic event schemas or mappings in runtime config
```

## Implementation Notes

- Runtime config comes from environment variables validated by shared config.
- Semantic config remains files/code.
- `.env.example` may include variable names but no real secret values.

## Acceptance Criteria

- [ ] `.env.example` or config templates exist.
- [ ] Templates cover ingester, processors, consumers, CLI, and storage clients.
- [ ] No plaintext secrets are present.
- [ ] Docs explain required vs optional variables.

## Checks

Run where possible:

```text
rg -n "password|secret|token|key" .env.example config infra docs/deployment
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

