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

### Initial triage SLAs

v1 defaults, applied per destination/processor DLQ:

```text
acknowledge (operator opens a triage ticket)        within 1 hour during business hours, 4 hours otherwise
classify (retryable vs permanent)                   within 4 hours of acknowledgement
resolve (retry succeeds or marked permanent)        within 24 hours of acknowledgement
escalate (DLQ growth continues during triage)       when DLQ size > acknowledged-batch + 1000
```

These are operational targets, not contractual. They tighten after observed traffic. The on-call rotation owns acknowledgement; the responsible processor/consumer owner classifies and resolves.

## Acceptance Criteria

- [ ] DLQ triage runbook exists.
- [ ] CLI commands referenced by runbook exist or are explicitly marked future.
- [ ] Triage SLAs match the table above and are documented as v1 defaults subject to revision.
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

