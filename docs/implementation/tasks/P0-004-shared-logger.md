# P0-004: Shared Logger Package

Status: Backlog

## Goal

Create a shared Pino logger package with standard context fields and redaction.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Codex Instructions](../../instructions/codex.md)

## Dependencies

- P0-001
- P0-002

## Write Scope

Allowed:

```text
packages/shared-logger/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
packages/shared-config/
packages/shared-kafka/
```

## Implementation Notes

- Use Pino.
- JSON logs only.
- Redact secrets, authorization headers, cookies, tokens, card fields, and passwords.
- Do not log raw event payloads by default.

## Acceptance Criteria

- [ ] `packages/shared-logger` exists.
- [ ] It exports logger creation helpers.
- [ ] Redaction defaults are covered by tests.
- [ ] Child logger/context usage is documented in package README or source comments.

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

