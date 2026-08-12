# attribution-engine v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, attribution outcomes (first-touch rule, last-touch rule,
delta detection, identifier preference order), output schema, or the
touchpoint_id derivation requires a new version directory (v2/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

## v1 — manifest standardisation (P8-006, 2026-05-15)

Non-semantic. Adds the cross-cutting manifest fields P8-006 standardised
across every released v1 processor: `release_status: released`,
`replay_notes` (lifts the existing inline replay caveats into a typed
field so the CLI / runbook render them without parsing YAML comments),
and the `fixtures` block referencing the golden touchpoint-captured
input/output pair under `test/golden/`. No code, no transform, no
touchpoint_id derivation change, no first-touch / last-touch rule
change, no emitted-event change. The attribution.events envelope shape
stays byte-identical to the v1.0.0 release. The
`replay.restrictions` array still carries `first_touch_replay_caveat`
/ `last_touch_replay_caveat` as the machine-readable surface. See
`docs/development/processor-manifests.md` for the schema convergence
plan and the semantic-immutability rule.

## v1.0.0 — initial release (P8-005)

- First attribution processor in the Polaris workspace.
- Consumes `analytics.events` (the analytics-projector's downstream
  stream of canonical envelopes that have already been processor-stamped).
- Maintains a touchpoint chain per `(project_id, environment,
  primary_identifier)` tuple. Primary identifier preference order:
  `customer_id > anonymous_id > session_id`. Events with no usable
  identifier are silently dropped (no chain to attribute to).
- Touchpoint detection: an event is a "touchpoint" iff its
  `context.campaign` block carries at least one non-null field
  (`source`, `medium`, `name`, `term`, `content`, `click_id`). Empty
  strings are normalised to null before detection.
- Emits three canonical event kinds on `attribution.events`:

  - `attribution.touchpoint_captured` — once per touchpoint observation.
  - `attribution.first_touch_assigned` — once per identifier, on first
    touchpoint.
  - `attribution.last_touch_assigned` — on first touchpoint AND whenever
    the canonical campaign tuple changes. Idempotent on the tuple —
    same-tuple observations do not re-emit.

- `touchpoint_id` is deterministic:
  `"tp_" + sha256(source_event_id ++ canonical_campaign_tuple)[0..32]`.
  Replays produce identical ids byte-for-byte.

- The processor stamp is dual-shape (nested `processor: {name, version,
  ran_at, run_id}` + flat `processor_name` / `processor_version`) so
  ClickHouse Kafka Engine ingestion reads both forms — matches the
  analytics-projector / identity-resolver / sessionizer stamp.

- v1 is intentionally CONSERVATIVE:

  - No vendor-specific destination logic. `click_id` is a single
    catch-all field; per-vendor splits (`gclid`, `fbclid`, `msclkid`) are
    OUT of scope. Downstream destinations interpret `click_id`.
  - No conversion detection. The engine only emits touchpoint chain
    events; downstream analytics joins to commerce / conversion events on
    `(project_id, environment, primary_identifier, occurred_at)` using
    project-specific semantics.
  - No multi-touch attribution weights. v1 records first-touch and
    last-touch; linear / time-decay / U-shape / data-driven models are
    new processor versions.
  - No within-session vs cross-session distinction. Touchpoints
    accumulate per identifier regardless of which session they fell in
    (per the SDK standards: "The SDK does not rotate sessions because
    campaign, UTM, referrer, or click IDs change. Attribution
    interpretation belongs downstream, not in the SDK.").

- Errors are routed through `@polaris/shared-processor`'s
  `classifyError`: decode failures and missing-envelope-field errors are
  classified as non-retryable. KafkaJS retries handle transient
  failures.

### Replay notes

Per the task card's Acceptance Criteria ("Replay notes describe how v1
behavior may affect historical outputs"):

1. The touchpoint chain is rebuilt FROM THE BEGINNING of the
   replay slice. A replay that starts AFTER an identifier's original
   first touchpoint will emit a NEW `first_touch_assigned` event for
   whichever touchpoint comes first in the slice. Downstream consumers
   should treat `first_touch_assigned` as authoritative ONLY when the
   replay window covers the identifier's full lifetime.

2. The same caveat applies to `last_touch_assigned`. A replay that
   starts mid-chain treats the slice's first touchpoint observation as
   a delta (no prior state), emitting `last_touch_assigned` for it even
   if the live runtime had previously emitted the same tuple. The
   manifest's `replay.restrictions` records this as
   `first_touch_replay_caveat` / `last_touch_replay_caveat`.

3. `touchpoint_captured` events ARE fully replay-stable: the
   `touchpoint_id` derivation is purely a function of
   `(source_event_id, campaign_tuple)`. Replays reproduce identical
   `touchpoint_captured` events byte-for-byte.

4. Order of emission within a single source event is deterministic:
   `touchpoint_captured` first, then (if applicable)
   `first_touch_assigned`, then `last_touch_assigned`. Consumers reading
   from the topic with `fromBeginning=true` can rely on this ordering.

### Known v1 limitations

- ~~**In-memory state only.**~~ **Resolved** — touchpoint chains moved to
  PostgreSQL per ADR 0005 (`attribution_touchpoint_chains`), over the
  pool the processor already holds for checkpoints. Chains now survive a
  restart, and they are queryable, which is a capability operators did
  not have at all.
- ~~**No background timer / no chain expiry.**~~ **Resolved by the
  same change**, and it was the more urgent half: an unbounded in-process
  map is a leak before it is a durability gap. Note the fix is bounding,
  not expiry — chains have no natural TTL (attribution windows run 30-90
  days), which is exactly why they went to PostgreSQL while session state
  went to Redis.
- **Trimming old chains is a v2 decision, not a retention chore.** The
  engine has no attribution-window concept at all — the manifest states
  that "no expiring windows participate" — so a chain is consulted no
  matter how old it is. Deleting one therefore CHANGES OUTPUT: the next
  touchpoint for that identifier becomes a new `first_touch_assigned`.
  Per the manifest's semantic-immutability rule, that requires a v2
  processor, not a scheduled DELETE. The table is bounded and durable
  today; giving it a retention policy means first deciding what the
  attribution window is.
- **A database outage stalls the processor.** With chains external, a
  Postgres failure fails the message rather than degrading: without the
  prior chain the engine cannot tell a first observation from a
  continuation, and guessing would emit `first_touch_assigned` for an
  identifier that already had one. The checkpoint does not advance and
  the message is redelivered.
- **No fallback when no identifier is present.** Events missing all of
  `customer_id`, `anonymous_id`, and `session_id` are silently dropped.
  The engine cannot attribute them to a chain. Producers should ensure
  at least one identifier is set; the Web SDK guarantees `anonymous_id`.
- **Empty-campaign events produce no emissions.** An event with
  `context.campaign: null` (or with all-null campaign fields) is
  observed for state-keeping (the engine records the event was seen)
  but emits no `attribution.*` event. This is intentional: every
  emission is keyed to a non-empty campaign observation, so silent
  pass-throughs don't dilute the `attribution.events` topic.
- **Vendor-specific click_id splitting is out of scope.** The single
  `campaign.click_id` field is recorded verbatim. Downstream destinations
  interpret it. A v2 may introduce per-vendor enrichment (`gclid` →
  Google Ads conversion API, `fbclid` → Meta CAPI), but that is
  vendor-specific destination logic and belongs in a separate processor.
