# P8-004: GeoIP Enricher v1

Status: Backlog

## Goal

Implement the first GeoIP enricher processor downstream from ingestion.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Ingestion and SDKs](../../architecture/04-ingestion-and-sdks.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P0-006

## Write Scope

Allowed:

```text
processors/geoip-enricher/v1/
catalog/events/enriched/
packages/shared-schemas/src/events/enriched/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
consumers/
```

## Implementation Notes

- GeoIP enrichment must not happen at ingress.
- If no real GeoIP database is available, implement a provider interface and a deterministic test provider.
- Do not add external data downloads without explicit approval.
- Output should be deterministic for test fixtures.

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] GeoIP provider interface exists.
- [ ] Test provider is deterministic.
- [ ] Processor emits enriched event or enrichment metadata.
- [ ] Tests cover valid IP, missing IP, and invalid IP behavior.

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

