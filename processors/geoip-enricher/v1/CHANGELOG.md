# geoip-enricher v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, identity links, attribution outcomes, filtering behavior, or
output schema requires a new version directory (v2/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

## Unreleased — derived event ids are now a function of their cause

Emitted `event_id`s were `uuidv7()` per attempt, so a redelivery or a replay
of the same input produced a NEW derived event every time.
`analytics_processed` is `ReplacingMergeTree` keyed on `event_id`, so those
duplicates never collapsed — they accumulated as distinct facts — and
`sql/clickhouse/32_analytics_processed.sql` justified that engine choice by
claiming derived ids were already deterministic.

Ids now come from `deriveEventId({ processor, sourceEventId, slot })`
(UUIDv5), where `slot` names which emission this is and is a pure function of
the source event. `processor_version` is deliberately excluded from the key:
including it would mint a fresh id generation on every fix, which is exactly
when you replay, and the replay would then collide with nothing.

Classified as a non-semantic correctness fix rather than a new version. The
envelope shape is unchanged, the field stays a UUID, and no mapping, identity,
attribution or filtering rule moved. What changes is that a value which was
never meaningful becomes meaningful. Consumers keying on `event_id` for
identity see stable values where they previously saw noise.

## v1 — manifest standardisation (P8-006, 2026-05-15)

Non-semantic. Adds the cross-cutting manifest fields P8-006 standardised
across every released v1 processor: `release_status: released`,
`replay_notes`, and the `fixtures` block referencing the golden
InMemoryIPLookup hit input/output pair under `test/golden/`. No code,
no transform, no IPLookup adapter changes, no SHA-256 hash drift, no
emitted-event change. The enriched.events envelope shape stays byte-
identical to the v1.0.0 release. The existing
`test/fixtures/geoip-sample.json` (the InMemoryIPLookup database) stays
where it is; the new golden pair is `test/golden/in-memory-ipv4-hit.{input,output}.json`.
See `docs/development/processor-manifests.md` for the schema convergence
plan and the semantic-immutability rule.

## v1.0.0 — initial release (P8-004)

- First geoip-enricher in the Polaris workspace.
- Consumes `raw.events`, looks up `envelope.context.ip` against a
  swappable `IPLookup` backend, and emits `enriched.geoip` v1 envelopes
  on `enriched.events` keyed back to the source `event_id` via
  `properties.source_event_id`.
- Output envelope shape per `packages/shared-schemas/src/events/enriched/geoip.v1.ts`:
  every geo field is nullable so partial lookups (city resolved, region
  missing) emit without forcing a schema bump.
- IPLookup adapters shipped in v1:
  - `InMemoryIPLookup` — backed by a small JSON fixture
    (`test/fixtures/geoip-sample.json`); used by tests, the smoke
    harness, and any integration scenario that wants deterministic geo
    results without the MaxMind binary database.
  - `NoOpIPLookup` — production fail-open default. Returns null for
    every lookup; the enricher emits a row with `source = "no_lookup"`
    so downstream consumers can still observe processing.
- PII posture: the raw IP NEVER appears on the enriched event or in any
  structured log line. The runtime hashes the IP with SHA-256 and
  persists only `source_ip_hash`. Even debug-level log lines include
  the hash, never the address.
- Fail-open: a missing or unreachable IPLookup database does not break
  the streaming pipeline. The enricher emits a null-geo enriched event
  with `source = "no_lookup"` so analytics and attribution can still
  join on `source_event_id`.
- A MaxMind GeoLite2-backed `MaxmindIPLookup` adapter is intentionally
  out of scope for v1 (binary database is large and license-restricted;
  lives outside the repo). The adapter lands in a follow-up task behind
  the same `IPLookup` interface and does not require bumping this
  processor version.
- Errors are routed through `@polaris/shared-processor`'s
  `classifyError`: decode failures and missing-envelope-field errors
  are classified as non-retryable. KafkaJS handles transient broker
  failures via its own retry semantics.
