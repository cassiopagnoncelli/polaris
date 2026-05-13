# identity-resolver v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, identity links, attribution outcomes, filtering behavior, or
output schema requires a new version directory (v2/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

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
