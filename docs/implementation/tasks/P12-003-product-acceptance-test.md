# P12-003: Product Acceptance Test

Status: Backlog

## Goal

Create a product-level acceptance test proving Polaris is usable for one internal project.

## Required Reading

- [Delivery Roadmap](../delivery-roadmap.md)
- [Coverage Matrix](../coverage-matrix.md)
- [Project README](../../README.md)

## Dependencies

- P5-001
- P6-003
- P7-002
- P9-002
- P10-003

## Write Scope

Allowed:

```text
tests/acceptance/
scripts/
docs/release/
docs/development/
```

Forbidden:

```text
architecture-changing edits
```

## Implementation Notes

Acceptance should prove:

- create project/source/key
- send Web or Node SDK event
- validate ingester acceptance
- observe processing
- query ClickHouse
- inspect delivery record or webhook sink
- run replay dry-run
- inspect dashboard/runbook links

## Acceptance Criteria

- [ ] Acceptance test or scripted checklist exists.
- [ ] It exercises at least one SDK event.
- [ ] It exercises control-plane key creation.
- [ ] It verifies analytical persistence.
- [ ] It verifies replay dry-run.
- [ ] It produces clear pass/fail output.

## Checks

Run where possible:

```text
pnpm test:acceptance
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

