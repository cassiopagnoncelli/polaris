# P11-006: Security Hardening: Origins, Rate Limits, and Forbidden Fields

Status: Partial — origin allow-list scaffold merged in `b8b9741`. Follow-up: rate-limit module, HSTS, body-size limit, app.ts wiring, OpenAPI 403/429 docs.

## Goal

Harden ingestion and SDK-facing controls for real internal traffic.

## Required Reading

- [Event Contract](../../architecture/01-event-contract.md)
- [Control Plane](../../architecture/02-control-plane.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)

## Dependencies

- P2-002
- P2-003
- P6-003

## Write Scope

Allowed:

```text
apps/ingester-api/
packages/shared-config/
packages/shared-service-bootstrap/
db/
migrations/
docs/operations/
```

Forbidden:

```text
SDK fingerprinting
destination mapping semantics
processor semantic changes
```

## Implementation Notes

Cover:

- frontend origin allowlist behavior
- rate-limit defaults
- max batch size
- max event size
- forbidden-field rejection/redaction
- audit for key abuse/revocation

This is hardening, not full consent enforcement.

## Acceptance Criteria

- [ ] Origin allowlist is implemented or clearly configured.
- [ ] Rate limiting exists for ingester requests.
- [ ] Max batch/event size is enforced.
- [ ] Forbidden-field guardrails are tested.
- [ ] Docs explain frontend publishable key risk model.

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

