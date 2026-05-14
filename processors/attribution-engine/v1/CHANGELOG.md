# attribution-engine v1 changelog

Processor versions are immutable in semantic behavior. This changelog records
non-semantic fixes (security patches, dependency bumps, observability tweaks)
that ship inside the released v1 artifact. Anything that changes emitted event
meaning, fields, attribution outcomes (first-touch rule, last-touch rule,
delta detection, identifier preference order), output schema, or the
touchpoint_id derivation requires a new version directory (v2/) — see
`docs/architecture/05-processors-and-replay.md` "Processor Versioning".

## v1.0.0 — initial release (P8-005)

- First attribution processor in the Polaris workspace.
- Consumes `analytics.events` (the analytics-projector's downstream
  stream of canonical envelopes that have already been processor-stamped).
- Maintains an in-memory touchpoint chain per `(project_id, environment,
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

1. The in-memory touchpoint chain is rebuilt FROM THE BEGINNING of the
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

- **In-memory state only.** Process restarts lose touchpoint chains.
  Acceptable for v1 because (a) the chain depth is bounded by the input
  slice, (b) the processor is replayable from `analytics.events`, and
  (c) the deterministic `touchpoint_id` derivation means a replay
  reproduces the same `touchpoint_captured` events. A Redis-backed v2
  will externalise the state store.
- **No background timer / no chain expiry.** A touchpoint chain
  persists in memory for the lifetime of the process. v2 should consider
  a TTL or LRU bound so a long-running process doesn't accumulate
  unbounded identifier state.
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
