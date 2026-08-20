# sessionizer v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, session windows, primary-identifier resolution, output
schema, or the inactivity-window value requires a new version directory
(v2/) — see `docs/architecture/05-processors-and-replay.md` "Processor
Versioning".

## Unreleased — derived event ids are now a function of their cause

Emitted `event_id`s were `uuidv7()` per attempt, so a redelivery or a replay
of the same input produced a NEW derived event every time.
`analytics_processed` is `ReplacingMergeTree` keyed on `event_id`, so those
duplicates never collapsed — they accumulated as distinct facts — and
`db/clickhouse/32_analytics_processed.sql` justified that engine choice by
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

## v1 — inactivity window is now actually pinned to the manifest

Non-semantic **bug fix**, with a caveat worth reading.

`POLARIS_SESSIONIZER_INACTIVITY_SECONDS` was passed straight through to the
runtime while the config comment claimed the runtime "ignores attempts to
widen it". It ignored nothing: a deployment could set any value and silently
run semantics that were not v1's — a wider window merges sessions v1 would
have split, a narrower one splits sessions v1 would have merged. The comment
also only mentioned widening, though narrowing is equally semantic.

The window now always comes from the manifest constant. The env var is still
accepted (so existing deployments do not fail to boot) and is ignored; when it
differs from the manifest value, `app.ts` logs a warn naming both numbers.

**Caveat:** a deployment that had set this variable to something other than
1800 was not running v1 semantics, and its emitted sessions will change after
this fix. That is the fix, not a regression — but it is a behaviour change for
such a deployment, and it is why this entry exists rather than a silent patch.
For anyone running the documented configuration, output is byte-identical.

## v1 — manifest standardisation (P8-006, 2026-05-15)

Non-semantic. Adds the cross-cutting manifest fields P8-006 standardised
across every released v1 processor: `release_status: released`,
`replay_notes`, and the `fixtures` block referencing the golden
session-started input/output pair under `test/golden/`. No code, no
transform, no session_id derivation change, no inactivity-window change
(still 1800s as a SEMANTIC default — bumping requires v2), no emitted-
event change. The session.events envelope shape stays byte-identical to
the v1.0.0 release. See `docs/development/processor-manifests.md` for
the schema convergence plan and the semantic-immutability rule.

## v1.0.0 — initial release (P8-003)

- First sessionizer in the Polaris workspace.
- Consumes `raw.events`, maintains an inactivity window per
  `(project_id, environment, primary_identifier)`, and emits
  `session.started` / `session.ended` events on `session.events`.
- Primary-identifier preference order: `customer_id` > `anonymous_id` >
  `session_id`. Events with none of these are silently dropped (no
  session affinity).
- Inactivity window: **1800 seconds (30 minutes)**, matching the Web SDK
  rotation rule in `docs/architecture/10-sdk-standards.md`. The value is
  semantic and lives in the manifest, not in env.
- `session_id` is deterministically derived from
  `(primary_identifier_kind, primary_identifier_value, started_at_iso)`
  via SHA-256, hex-encoded, and prefixed `sess_`. Replays produce the
  same value byte-for-byte.
- Campaign / click-id changes do NOT rotate sessions. Per the SDK
  standards, those changes are captured in context only.
- SDK `session_id` is treated as a HINT and never feeds the processor's
  own session_id derivation. Reinterpretation during replay is therefore
  possible without consulting the SDK's prior session state.
- v1 does NOT emit `session.continued`. Per-event "alive" updates land
  only in the in-memory store; emitting on every continue would 2-5x
  the output volume without adding information downstream.
- Lazy expiration: the sessionizer detects inactivity on the next event
  for the same key. No background timer. A long-idle key produces its
  `session.ended` on the next observed event — `ended_at` is anchored
  to `last_seen_at + inactivity_seconds` so the timeline is stable
  across replays.
- Errors are routed through `@polaris/pipeline`'s
  `classifyError`: decode failures and missing-envelope-field errors
  are classified as non-retryable. KafkaJS retries handle transient
  failures.

### Known v1 limitations

- ~~**In-memory state only.**~~ **Resolved** — session state moved to
  Redis per ADR 0005. Windows now survive a restart, and key expiry
  carries the inactivity rule, so `gcExpired()` and the background sweep
  it anticipated are gone rather than promoted to a timer. The trade is
  recorded in the ADR: a Redis outage now stalls the sessionizer
  (messages are redelivered) rather than degrading it, because guessing
  at a missing prior record would mint a wrong `session_id` for an
  in-flight session. Note the TTL is wall-clock while `decideSession`
  compares event time — during replay a record may outlive its
  event-time window, and the transform still correctly expires it. The
  TTL bounds storage; the transform owns the decision.
- **No background timer.** `session.ended` only emits on the next
  observed event for the same key. A key that goes idle and never
  returns will have no `session.ended` emitted in real time. The
  end-of-day rebuild and replay paths still emit the boundary event
  because they process the input slice in order.
- **No fallback when no identifier is present.** Events missing all of
  `customer_id`, `anonymous_id`, and `session_id` are silently dropped.
  The sessionizer cannot attribute them to a session window. Producers
  should ensure at least one identifier is set; the Web SDK guarantees
  `anonymous_id`.
