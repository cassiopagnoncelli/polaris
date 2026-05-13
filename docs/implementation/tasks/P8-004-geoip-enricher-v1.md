# P8-004: GeoIP Enricher v1

Status: Ready

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
  processors/geoip-enricher/v1/                                    NEW package
    package.json
    tsconfig.json
    vitest.config.ts
    processor.manifest.yaml
    CHANGELOG.md
    src/
      app.ts            service bootstrap (Fastify shell + KafkaJS wiring)
      config.ts         Zod-validated runtime config
      emit.ts           canonical enriched.events envelope builder
      index.ts          public barrel
      ip.ts             parseIp + hashIp (SHA-256) — PII-safe IP helpers
      lookup.ts         IPLookup interface + InMemoryIPLookup + NoOpIPLookup + fromFixture
      main.ts           binary entry point
      runtime.ts        streaming runtime (decode → decideEnrichment → publish)
      transform.ts      pure transform: raw event → EnrichmentDecision
      types.ts          local RawEventEnvelope shape
    test/
      transform.test.ts (17 tests)
      runtime.test.ts (10 tests)
      schema.test.ts (5 tests)
      fixtures/geoip-sample.json    8.8.8.8 / 203.0.113.10 / 2001:db8::1

  catalog/events/enriched/geoip.v1.yaml                            NEW (catalog entry)

  packages/shared-schemas/src/events/enriched/geoip.v1.ts          NEW (Zod schema)
  packages/shared-schemas/src/index.ts                             MODIFIED (re-export)
  packages/shared-schemas/src/catalog/bindings.ts                  MODIFIED (register binding)
  packages/shared-schemas/test/catalog.test.ts                     MODIFIED (listEventNames assertion)

Commands run:
  pnpm install
  pnpm -r --if-present build
  pnpm --filter @polaris/processor-geoip-enricher-v1 typecheck          PASS
  pnpm --filter @polaris/processor-geoip-enricher-v1 test               PASS (32/32)
  pnpm --filter @polaris/processor-geoip-enricher-v1 lint               PASS
  pnpm --filter @polaris/shared-schemas test                            PASS (43/43)
  pnpm typecheck                                                        PASS (workspace)
  pnpm lint                                                             PASS (workspace)
  pnpm format:check                                                     PASS (workspace)
  pnpm test                                                             1187 pass, 30 fail
    All 30 failures are in apps/ingester-api/test/ingest/handler.test.ts
    and stem from one fixture gap (see "Known gaps / cross-cut" below).

Checks passed:
  - Versioned processor v1 directory with processor.manifest.yaml and CHANGELOG.md.
  - `IPLookup` interface + `InMemoryIPLookup` (test fixture) + `NoOpIPLookup`
    (production fail-open default).
  - Deterministic in-memory test provider (`test/fixtures/geoip-sample.json`,
    8.8.8.8 → US/Mountain View etc.).
  - `enriched.geoip` v1 catalog entry + Zod schema + bindings registration.
  - Runtime emits `enriched.geoip` v1 envelopes on `enriched.events` keyed
    on `properties.source_event_id`.
  - `properties.source` literal names the backend (e.g. `in_memory:test-fixture`,
    `no_lookup`, `no_ip`). MaxMind dataset versioning lands when the
    follow-up MaxmindIPLookup adapter is added.
  - PII guarantee: a dedicated test pipes Pino output to an in-memory
    stream at debug level and asserts NO raw IPv4-octet string and no
    literal "8.8.8.8" appear in any captured line. The hash IS present.
    The error-path emission is covered separately.
  - NoOpIPLookup fail-open: runtime emits an enriched event with
    `source = "no_lookup"` and every geo field null, instead of crashing.
  - IPv4, IPv6, missing IP, invalid IP cases all produce valid Zod-checked
    payloads (see `test/schema.test.ts`).
  - Idempotency: replaying the same canonical envelope twice yields a
    byte-identical `properties` payload (the runtime mints a fresh event_id
    per emission as required, but the determinism contract holds on the
    semantic payload).

Known gaps / cross-cut:

  - apps/ingester-api/test/fixtures.ts needs a matching YAML stub entry
    for enriched.geoip v1 in its `buildTestCatalog` helper (next to the
    identity.linked/merged/rotated entries already there). The orchestrator
    must add this in the integration commit because `apps/ingester-api/`
    is forbidden scope for this task. Without it, the ingester-api
    handler tests fail with:
      "Schema binding enriched.geoip v1 has no catalog YAML entry"
    Suggested entry shape:
      {
        name: "enriched.geoip",
        schema_version: 1,
        domain: "enriched",
        owner: "platform-data",
        description: "processor-emitted v1",
        lifecycle: "active",
      }
    Once added, the 30 ingester-api handler tests (currently failing only
    because of this 1:1 binding/YAML check) go back to green.

  - MaxMind GeoLite2-backed `MaxmindIPLookup` adapter is intentionally
    NOT included in v1 (large/license-restricted binary database, not
    in repo). The follow-up task adds the adapter behind the existing
    `IPLookup` interface; no v1 processor version bump required.
    The task card's `POLARIS_GEOIP_DB_PATH` env var, file-reload-on-rename
    behaviour, and `maxmind` npm dependency all land in that follow-up.
    The v1 manifest's `description` and the CHANGELOG document the
    boundary explicitly.

  - Output shape differs from the task card's "context.geo.*" sketch.
    The implementation emits a NEW `enriched.geoip` event keyed on
    `properties.source_event_id` rather than mutating the source
    envelope's `context.geo` block. This matches the architecture's
    "Processors do not mutate existing events" rule
    (docs/architecture/05-processors-and-replay.md). Downstream
    consumers (analytics, attribution) join on `source_event_id`. The
    geo fields are top-level in `properties` (country_code, region_code,
    city, latitude, longitude, timezone, postal_code, accuracy_radius_km)
    so consumers don't need a nested `.geo.` traversal.

  - Per-project activation table wiring (P6-005 control plane) is
    out of scope here. v1 consumes all of raw.events unconditionally,
    matching the analytics-projector and identity-resolver postures.

  - `properties.source_ip_hash` is unsalted SHA-256. The architecture's
    forbidden-field-policy doc allows this for `pii_secret` redaction
    surfaces but a future hardening pass might switch to HMAC keyed on
    project_id. That's a v2 concern.

  - The processor binary entry point (`main.ts`) is wired through the
    same Fastify bootstrap as analytics-projector. Production deployments
    pull config from `POLARIS_*` env vars (see `src/config.ts`).
```

## Rebase Report

Worktree was at base `f8ded93` (Sync kanban + statuses after batch 8) before
work started. Rebased onto `main` (`ef01dea` Sync kanban + statuses after
batch 11 partial). Rebase was clean — no conflicts. The expected base
commits from the briefing are all present in the rebased history
(P8-001 helpers at `3d4e09b`, P8-002 identity-resolver at `a9dd1cf`,
P10-001 observability at `d5ab28f`).
