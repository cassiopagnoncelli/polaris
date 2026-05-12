# P8-002: Identity Resolver v1

Status: Ready

## Goal

Implement the first authoritative-link identity resolver processor.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P0-006

## Write Scope

Allowed:

```text
processors/identity-resolver/v1/
packages/shared-processor/
catalog/events/identity/
packages/shared-schemas/src/events/identity/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
consumers/
```

## Implementation Notes

- Canonical graph accepts explicit authoritative links only.
- Heuristics must not mutate canonical identity, but the storage shape must remain open so new heuristic rules can land without schema migrations.
- Storage layer quality from the SDK may be retained as evidence metadata.
- Emit events such as `identity.linked` or equivalent governed event names if defined.
- If schema names are not defined yet, add them through the file-backed catalog and code-backed schemas.

### Storage shape (extensible)

Single `identity_links` table designed so new evidence types can be added without migrations:

```text
identity_links
  id                  uuidv7
  project_id          text
  environment         text
  left_identifier     text       e.g., "anonymous_id:anon_abc"
  right_identifier    text       e.g., "customer_id:cus_123"
  confidence          enum       'authoritative' | 'candidate'
  evidence_type       text       open vocabulary, e.g., "explicit_overlap", "session_proximity", future rules
  evidence            jsonb      heuristic-specific data; schema is per-evidence_type
  reason              text       human-readable explanation
  processor_name      text
  processor_version   text
  run_id              uuidv7
  created_at          timestamptz
  superseded_at       timestamptz nullable; links can be retired without deletion
```

Rules:

- `confidence = 'authoritative'` is the only value emitted by v1 explicit-overlap logic.
- `confidence = 'candidate'` is reserved for future heuristic processors.
- `evidence_type` is an **open** vocabulary, not a Postgres enum. New rule types land by inserting rows with a new `evidence_type` value and code that interprets it. No migration required.
- `evidence` is `jsonb` so each `evidence_type` defines its own shape. A small registry in code documents the expected shape per type.
- Queries that need to distinguish authoritative from candidate filter on `confidence`. The default identity-resolver view returns authoritative only.
- Heuristic promotion (candidate → authoritative) is an UPDATE on the row, not a cross-table move.
- Index on `(project_id, environment, left_identifier)` and `(project_id, environment, right_identifier)` for graph traversal.

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] Authoritative overlap links are detected and stored with `confidence = 'authoritative'` and `evidence_type = 'explicit_overlap'`.
- [ ] Heuristic inputs do not create canonical merges (no rows with `confidence = 'authoritative'` from heuristic sources in tests).
- [ ] Storage uses the flexible schema: `evidence_type` text + `evidence` jsonb, allowing new rule types without migrations.
- [ ] The default identity view returns only authoritative links unless candidate is explicitly requested.
- [ ] Output events include processor metadata.
- [ ] Golden fixtures cover anonymous-to-customer linking and conflict cases.
- [ ] Tests verify a new `evidence_type` value can be inserted and read back without schema changes.

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

