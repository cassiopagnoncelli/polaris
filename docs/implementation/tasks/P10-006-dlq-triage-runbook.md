# P10-006: DLQ Triage Runbook

Status: Backlog

## Goal

Document and script the operational workflow for inspecting, retrying, and resolving DLQ events.

## Required Reading

- [Redpanda Topics](../../architecture/03-redpanda-topics.md)
- [Destinations](../../architecture/06-destinations.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)

## Dependencies

- P9-007
- P6-006

## Write Scope

Allowed:

```text
docs/operations/
apps/polaris-cli/
scripts/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
semantic processor/consumer mapping code
```

## Implementation Notes

Runbook should define:

- how to inspect DLQ volume
- how to inspect one DLQ event
- how to classify retryable vs permanent failure
- how to retry safely
- how to mark resolved
- how replay policy affects destination retries

## Acceptance Criteria

- [ ] DLQ triage runbook exists.
- [ ] CLI commands referenced by runbook exist or are explicitly marked future.
- [ ] Retry safety and idempotency are documented.
- [ ] Secret redaction expectation is documented.

## Checks

Run where possible:

```text
rg -n "DLQ|retry|resolved|idempot" docs/operations
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

