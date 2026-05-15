# sessionizer v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, session windows, primary-identifier resolution, output
schema, or the inactivity-window value requires a new version directory
(v2/) — see `docs/architecture/05-processors-and-replay.md` "Processor
Versioning".

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
- Consumes `raw.events`, maintains an in-memory inactivity window per
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
- Errors are routed through `@polaris/shared-processor`'s
  `classifyError`: decode failures and missing-envelope-field errors
  are classified as non-retryable. KafkaJS retries handle transient
  failures.

### Known v1 limitations

- **In-memory state only.** Process restarts lose active session
  windows; the next event for a key opens a NEW session rather than
  resuming the prior window. Acceptable for v1 because (a) the window
  is short (30 min) so loss is bounded, (b) the processor is replayable
  from `raw.events`, and (c) the deterministic session_id derivation
  means a replay reproduces the same output. A Redis-backed v2 will
  externalize the state store.
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
