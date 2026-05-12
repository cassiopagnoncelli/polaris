# P12-002: API Docs and OpenAPI Publishing

Status: Backlog

## Goal

Publish usable API documentation for the ingester and any control-plane/admin HTTP APIs.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P2-003
- P6-001

## Write Scope

Allowed:

```text
docs/api/
apps/ingester-api/
apps/*/
scripts/
```

Forbidden:

```text
event schema semantic changes unless correcting docs drift
```

## Implementation Notes

- OpenAPI should be generated from route schemas.
- Do not hand-write specs that drift from implementation.
- Include examples for batch partial acceptance and Problem Details errors.

## Acceptance Criteria

- [ ] OpenAPI generation command exists.
- [ ] Generated spec is committed or documented according to repo policy.
- [ ] API docs include auth, batch ingestion, error format, and examples.
- [ ] Docs link to SDK handbook.

## Checks

Run where possible:

```text
pnpm openapi
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

