# identity-resolver v1 changelog

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
authoritative-overlap input/output pair under `test/golden/`. No code,
no transform, no identity_links semantics, no emitted-event change. The
processor stamp and the identity.events envelope shape stay byte-
identical to the v1.0.0 release. See
`docs/development/processor-manifests.md` for the schema convergence
plan and the semantic-immutability rule.

## v1.0.0 — initial release (P8-002)

- First identity-resolver in the Polaris workspace.
- Consumes `raw.events`, emits `identity.linked` / `identity.merged` /
  `identity.rotated` events on `identity.events`, and writes durable links
  to the `identity_links` PostgreSQL table.
- Detection rule: **explicit-overlap only**. A single event carrying two
  strong identifiers (e.g. `anonymous_id + customer_id` in the canonical
  `identity` block) yields one authoritative link. Heuristic rules
  (session proximity, device continuity) are NOT in v1 and will be emitted
  by future processors with `confidence = candidate`.
- `evidence_type` written by v1: `explicit_overlap`. `evidence` payload:
  `{ source_event_id, source_event_name, source_schema_version }`.
- Idempotency is enforced by the partial unique index on the active
  `(project_id, environment, left_identifier, right_identifier,
  evidence_type)` tuple. Replaying the same `raw.events` slice yields the
  same set of `identity_links` rows.
- Errors are routed through `@polaris/shared-processor`'s `classifyError`:
  decode failures and missing-envelope-field errors are classified as
  non-retryable. KafkaJS retries handle transient failures.
