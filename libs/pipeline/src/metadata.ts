/**
 * Processor metadata stamping.
 *
 * Per `docs/architecture/05-processors-and-replay.md` "Processor Metadata",
 * every derived event carries a structured `processor` object recording the
 * processor `(name, version, run_id)` that produced it. Polaris additionally
 * stamps flat `processor_name` / `processor_version` columns onto the
 * envelope so ClickHouse's `analytics_events_queue` Kafka Engine table can
 * read them directly (the queue uses `JSONEachRow` with
 * `input_format_skip_unknown_fields = 1`, so both shapes coexist cleanly).
 *
 * The helper exposed here is the SINGLE source of truth for the dual shape:
 * processors must not hand-roll the literal again. Tests against the
 * golden-fixture in `sync/legacy/analytics-projector/v1` lock the wire shape.
 *
 * The helper is intentionally synchronous and free of I/O: it can be called
 * from the streaming runtime, from replay tooling, and from unit tests
 * without setup. Determinism (the `ran_at` timestamp) is delegated to the
 * caller via the `now()` option.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Metadata"
 * @see docs/architecture/03-rabbitmq-streams.md "Retry and DLQ Topics"
 */

import type { ProcessorIdentity } from "./identity.js";

/**
 * Stamp the structured `processor` block placed on every derived envelope.
 *
 * `ran_at` is an ISO 8601 UTC timestamp recording when this specific
 * transform invocation produced the output — useful for staleness inspection
 * and replay lineage diff. `run_id` is the per-run UUIDv7 assigned by
 * `registerRun()`; it is optional because non-run transforms (replay dry-run,
 * golden-fixture tests) still need a valid stamp shape.
 */
export interface ProcessorStamp {
  readonly name: string;
  readonly version: string;
  readonly ran_at: string;
  readonly run_id?: string | undefined;
}

/**
 * Options accepted by `stampProcessorMetadata`. The wall-clock source is
 * injectable so callers (replay, golden-fixture tests) can pin `ran_at`
 * deterministically.
 */
export interface StampProcessorMetadataOptions {
  readonly identity: ProcessorIdentity;
  readonly run_id?: string | undefined;
  /**
   * Wall-clock source. Defaults to `() => new Date()` for production.
   * Tests pass a frozen function to make `ran_at` deterministic.
   */
  readonly now?: () => Date;
}

/**
 * Helper-side view of an inbound envelope. The transform copies every named
 * field rather than spreading the input, so this declaration is intentionally
 * narrow on the canonical envelope's primitive fields while leaving
 * `source` / `identity` / `context` / `properties` deliberately open with
 * `unknown` — concrete processors carry their own tighter typing for those
 * nested layers, and the helper does not look inside them.
 *
 * `consent` and `privacy` are kept as optional because the ingester does not
 * always emit them; the helper preserves their absence rather than emitting
 * `undefined` (which would clutter ClickHouse's tolerant `JSONEachRow`).
 */
export interface CanonicalEnvelopeInput {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: unknown;
  readonly identity: unknown;
  readonly context: unknown;
  readonly properties: unknown;
  readonly consent?: unknown;
  readonly privacy?: unknown;
  /**
   * Platform-owned blocks (T3K2KULJ). Absent from this type until
   * 2026-08-18, which meant the stamp below dropped them: `buildSpineEvent`
   * and the enrichment stage had each independently worked around it by
   * re-adding their block AFTER stamping, and the resolver's
   * `buildProfileUpdatedEvent` -- which had no such workaround -- shipped
   * `profile.updated` with no profile block at all. The sink reads
   * `profile.profile_id`, found none, and skipped every one.
   */
  readonly profile?: unknown;
  readonly enrichment?: unknown;
}

/**
 * Output of `stampProcessorMetadata`. Mirrors the input envelope verbatim,
 * adds the nested `processor` stamp, and adds the flat ClickHouse columns
 * `processor_name` / `processor_version`. The shape is generic over the
 * input envelope so concrete processors keep their narrower property types
 * (e.g. closed-set `source.type` literals) on the way out.
 */
export type StampedEnvelope<E extends CanonicalEnvelopeInput> = E & {
  readonly processor: ProcessorStamp;
  readonly processor_name: string;
  readonly processor_version: string;
};

/**
 * Produce a derived envelope from a canonical envelope by stamping processor
 * metadata in both nested and flat shapes.
 *
 * Implementation notes:
 *
 *   - Every envelope field is copied by reading the named property
 *     explicitly rather than spreading the input. The explicit copy guards
 *     against the transform silently propagating any *additional* fields a
 *     future raw event might carry — the analytics envelope stays a known,
 *     audited shape.
 *
 *   - The optional blocks (`consent`, `privacy`, `profile`, `enrichment`)
 *     are only included on the output when the input actually had them.
 *     Emitting `consent: undefined` would clutter ClickHouse's `consent`
 *     text column with the literal string `"undefined"` during JSON
 *     serialisation.
 *
 *   - Keeping that list current is load-bearing. `profile` and
 *     `enrichment` were missing from it for as long as they have existed,
 *     so this function silently deleted them; two callers had each worked
 *     around it locally and a third lost data because it had not.
 *
 *   - The helper does not import `@polaris/spec`. Processors that
 *     need stricter envelope validation should run the inbound payload
 *     through the canonical envelope Zod schema before calling this helper.
 *     The platform's envelope validator (the ingester) is authoritative;
 *     re-running the full validator on every consumed message would
 *     double-validate the hot path.
 */
export function stampProcessorMetadata<E extends CanonicalEnvelopeInput>(
  envelope: E,
  options: StampProcessorMetadataOptions,
): StampedEnvelope<E> {
  const now = options.now ?? (() => new Date());
  const ranAt = now().toISOString();

  const stamp: ProcessorStamp =
    options.run_id !== undefined
      ? {
          name: options.identity.name,
          version: options.identity.version,
          ran_at: ranAt,
          run_id: options.run_id,
        }
      : {
          name: options.identity.name,
          version: options.identity.version,
          ran_at: ranAt,
        };

  const base = {
    event_id: envelope.event_id,
    event: envelope.event,
    schema_version: envelope.schema_version,
    project_id: envelope.project_id,
    environment: envelope.environment,
    occurred_at: envelope.occurred_at,
    ingested_at: envelope.ingested_at,
    source: envelope.source,
    identity: envelope.identity,
    context: envelope.context,
    properties: envelope.properties,
    processor: stamp,
    processor_name: options.identity.name,
    processor_version: options.identity.version,
  };

  // exactOptionalPropertyTypes forbids re-emitting `consent: undefined`
  // when the input did not carry it, so each optional block is spread in
  // only when present -- the key is absent rather than set to undefined.
  //
  // This was a chain of `if` branches over consent and privacy alone.
  // Adding a third and fourth block to that shape is a cartesian product
  // of returns, which is its own argument for spreading: the allowlist is
  // deliberate (see above) and it should be cheap to keep current, because
  // the cost of it falling behind the envelope is silent field loss.
  return {
    ...base,
    ...(envelope.consent !== undefined ? { consent: envelope.consent } : {}),
    ...(envelope.privacy !== undefined ? { privacy: envelope.privacy } : {}),
    ...(envelope.profile !== undefined ? { profile: envelope.profile } : {}),
    ...(envelope.enrichment !== undefined ? { enrichment: envelope.enrichment } : {}),
  } as StampedEnvelope<E>;
}
