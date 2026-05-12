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
- Catalog YAML must include `lifecycle` field (`active`, `deprecated`) and an optional `sunset_at` for deprecated versions.
- Implement the schema evolution model from [Event Contract / Schema Evolution](../../architecture/01-event-contract.md): per-event integer `schema_version`, in-place vs version-bump rules, coexistence of versions, deprecation with sunset.
- Schema files are organized as `packages/shared-schemas/src/events/<domain>/<event>.v<N>.ts`. Multiple versions of the same event coexist as separate files.
- Catalog entries reference exact `schema_version` values; the loader exposes the union of active versions.
- Include a small evolution test that validates both an `active` and a `deprecated` example of the same event name, and rejects an event whose `schema_version` is past `sunset_at`.

## Acceptance Criteria

- [ ] Event catalog folder structure exists.
- [ ] At least one event catalog YAML exists.
- [ ] Matching Zod property schema exists.
- [ ] Envelope schema exists.
- [ ] Tests cover valid and invalid event examples.
- [ ] Catalog supports `lifecycle` and `sunset_at`.
- [ ] Loader returns versions per event with their lifecycle state.
- [ ] At least one event has both v1 (deprecated, with `sunset_at`) and v2 (active) fixtures demonstrating coexistence.
- [ ] Tests verify the ingester reason codes `unsupported_schema_version` and `schema_version_sunset` produce the right shape when emitted (codes only — emission lands in P2-003).

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

