# P12-005: Release Candidate Checklist

Status: Backlog

## Goal

Create the release candidate checklist that gates internal product delivery.

## Required Reading

- [Delivery Roadmap](../delivery-roadmap.md)
- [Coverage Matrix](../coverage-matrix.md)
- [Engineering Standards](../../architecture/09-engineering-standards.md)

## Dependencies

- P12-003
- P12-004
- P10-005
- P11-005

## Write Scope

Allowed:

```text
docs/release/
docs/operations/
docs/deployment/
```

Forbidden:

```text
implementation code
```

## Implementation Notes

Checklist should cover:

- CI green
- vertical slice smoke test
- product acceptance test
- backup/restore runbook reviewed
- DLQ runbook reviewed
- replay dry-run verified
- SDK docs reviewed
- API docs reviewed
- dashboards available
- alert/runbook links available
- secrets not stored in repo/PostgreSQL
- known limitations documented

## Acceptance Criteria

- [ ] Release checklist exists.
- [ ] Checklist references concrete commands or docs.
- [ ] Known limitations section exists.
- [ ] Sign-off owners are identified as roles, not specific people.

## Checks

Run where possible:

```text
rg -n "CI|smoke|acceptance|backup|DLQ|replay|SDK|API|dashboard|secret" docs/release
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

