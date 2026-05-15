# analytics-projector v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, identity links, attribution outcomes, filtering behavior, or
output schema requires a new version directory (v2/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

## v1 — manifest standardisation (P8-006, 2026-05-15)

Non-semantic. Adds the cross-cutting manifest fields P8-006 standardised
across every released v1 processor: `release_status: released`,
`replay_notes`, and the `fixtures` block referencing the golden
input/output pair under `test/golden/`. No code, no transform, no
emitted-event change. The processor stamp and the analytics.events
envelope shape stay byte-identical to the v1.0.0 release. See
`docs/development/processor-manifests.md` for the schema convergence
plan and the semantic-immutability rule.

## v1.0.0 — initial release (P4-001)

- First processor in the Polaris workspace; establishes the
  `processors/<name>/v<n>/` directory shape for future P8 processors.
- Consumes `raw.events`, emits each event to `analytics.events`.
- Transform is a passthrough: every canonical envelope field (event_id,
  event, schema_version, project_id, environment, occurred_at,
  ingested_at, source, identity, context, consent, privacy, properties)
  is copied verbatim from the input event.
- Stamps `processor` metadata on the emitted envelope:
  - nested form `processor: { name: "analytics-projector", version: "v1", ran_at: <ISO 8601> }`
    so downstream replay and traceability tooling can reason about
    lineage without parsing top-level columns.
  - top-level `processor_name` / `processor_version` fields so the
    ClickHouse Kafka Engine table (sql/clickhouse/10_analytics_events_queue.sql)
    can ingest the JSON without schema gymnastics.
- Skeleton scope: consumes all `raw.events` traffic regardless of
  project. Per-project activation is wired by P6-005 (processor runtime
  CLI) and read from the PostgreSQL activation table.
