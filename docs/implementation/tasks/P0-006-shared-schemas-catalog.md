# P0-006: Shared Schemas and Event Catalog

Status: Backlog

## Goal

Create the file-backed event catalog and code-backed Zod schemas for the first sample governed event.

## Required Reading

- [Event Contract](../../architecture/01-event-contract.md)
- [Codex Instructions](../../instructions/codex.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)

## Dependencies

- P0-001
- P0-002

## Write Scope

Allowed:

```text
catalog/events/
packages/shared-schemas/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
sql/
```

## Implementation Notes

- Use a rigid canonical envelope.
- Add one governed sample event, preferably `page.viewed` or `checkout.started`.
- Include an `experimental.*` handling path if simple, but do not overbuild.
- The ingester will later use this package for validation.

## Acceptance Criteria

- [ ] Event catalog folder structure exists.
- [ ] At least one event catalog YAML exists.
- [ ] Matching Zod property schema exists.
- [ ] Envelope schema exists.
- [ ] Tests cover valid and invalid event examples.

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

