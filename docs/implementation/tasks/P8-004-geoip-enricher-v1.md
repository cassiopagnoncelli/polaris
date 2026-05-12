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
- v1 uses **MaxMind GeoLite2** as the data source. The operator provides the database files (`GeoLite2-City.mmdb`, `GeoLite2-Country.mmdb`) — Polaris does not auto-download them. License agreement is the operator's responsibility.
- The database file path is configurable via `POLARIS_GEOIP_DB_PATH` env var, validated by shared config.
- File reload: the enricher watches the file path and reloads on change (atomic rename pattern). Operators update GeoLite2 monthly by replacing the file.
- Use the official `maxmind` npm reader (or `@maxmind/geoip2-node`) to parse `.mmdb` files.
- Implement a `GeoIpProvider` interface so the backend is swappable (MaxMind GeoLite2 → GeoIP2 → IP2Location → custom) without rewriting the processor. v1 ships the MaxMind GeoLite2 provider; tests include a deterministic in-memory provider.
- Output should be deterministic for test fixtures.
- Enrichment fields produced (best-effort, missing values left null):

```text
context.geo.country_code
context.geo.country_name
context.geo.region_code
context.geo.region_name
context.geo.city
context.geo.postal_code
context.geo.latitude       coarse (city-level)
context.geo.longitude      coarse (city-level)
context.geo.timezone
context.geo.accuracy_radius
context.geo.source         "maxmind_geolite2_<version>"
```

## Acceptance Criteria

- [ ] Versioned processor exists with manifest and changelog.
- [ ] `GeoIpProvider` interface exists; MaxMind GeoLite2 provider implements it.
- [ ] Operator-provided file at `POLARIS_GEOIP_DB_PATH` loads at startup.
- [ ] File reload on atomic rename works without restart.
- [ ] Deterministic in-memory test provider exists.
- [ ] Processor emits enriched event with `context.geo.*` fields including `source` naming the MaxMind dataset version.
- [ ] Tests cover valid IP, missing IP, invalid IP, IPv6, and missing-database-file behavior.

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

