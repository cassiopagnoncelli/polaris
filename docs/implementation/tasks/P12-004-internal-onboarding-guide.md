# P12-004: Internal Onboarding Guide

Status: Backlog

## Goal

Write the guide an internal project team follows to onboard to Polaris.

## Required Reading

- [Project README](../../README.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P12-001
- P12-002
- P6-003

## Write Scope

Allowed:

```text
docs/onboarding/
docs/sdk/
docs/api/
```

Forbidden:

```text
implementation code unless fixing docs drift
```

## Implementation Notes

Guide should cover:

- requesting/creating a project/source
- creating frontend/backend keys
- choosing event names
- adding an event schema
- installing Web SDK
- installing Node SDK
- sending first event
- checking ingestion outcome
- viewing analytics
- requesting destination enablement
- support/escalation path

## Acceptance Criteria

- [ ] Onboarding guide exists.
- [ ] Guide uses real commands from CLI docs.
- [ ] Guide links to SDK and API docs.
- [ ] Guide explains strict schema governance.
- [ ] Guide includes troubleshooting section.

## Checks

Run where possible:

```text
rg -n "project|source|key|schema|SDK|troubleshooting" docs/onboarding
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

