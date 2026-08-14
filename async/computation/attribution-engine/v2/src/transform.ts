/**
 * Pure transform helpers for attribution-engine v1.
 *
 * The engine's hot path:
 *
 *   1. Resolve the primary identifier from the canonical envelope's
 *      `identity` block (preference order: customer_id > anonymous_id >
 *      session_id). Events with no usable identifier are dropped.
 *
 *   2. Normalise the canonical envelope's `context.campaign` block into
 *      the wire-stable `CampaignTuple` shape. Empty strings become
 *      `null`; missing fields become `null`. A tuple with every field
 *      `null` is considered EMPTY (no touchpoint).
 *
 *   3. Consult the touchpoint chain for the
 *      `(project_id, environment, primary_identifier)` key.
 *
 *   4. Decide which combination of emissions to produce:
 *        - drop                — no usable identifier OR empty campaign.
 *        - touchpoint_only     — same-tuple-as-prior (idempotent delta).
 *        - touchpoint_and_last — tuple differs from prior last-touch.
 *        - first_observation   — first touchpoint for this identifier
 *                                (emits touchpoint + first + last).
 *
 * Functions here are intentionally pure (no I/O, no Date.now) so the
 * runtime can drive them with deterministic clocks in tests and the
 * future replay executor can reuse them offline.
 *
 * Static processor identity is also exported here so the runtime,
 * bootstrap, tests, and DLQ helpers reference the same constants.
 */

import { createHash } from "node:crypto";

import type { AttributionEventCampaign, AttributionEventIdentity } from "./types.js";

/**
 * Static identity for v2 — held as a frozen literal so call sites cannot
 * mutate it.
 */
export const PROCESSOR_NAME = "attribution-engine" as const;
export const PROCESSOR_VERSION = "v2" as const;

/**
 * Attribution window, in seconds. 90 days.
 *
 * A touchpoint chain resets when the gap between the incoming event's
 * `occurred_at` and the chain's `last_observed_at` exceeds this. The next
 * touchpoint after that gap opens a NEW chain and is assigned first
 * touch.
 *
 * ## Why an inactivity gap and not an absolute chain age
 *
 * An absolute cap ("a chain dies 90 days after its first touch") resets
 * users mid-journey: someone touching weekly for a year would get an
 * arbitrary new first-touch every quarter. An inactivity gap only fires
 * when the journey has actually gone quiet, which is what "the previous
 * campaign no longer deserves credit" means.
 *
 * It also makes retention and semantics the SAME number. A row whose
 * `last_observed_at` is older than this window can never be consulted
 * again — the next event for that identifier is guaranteed to reset the
 * chain — so deleting it is provably free of semantic effect. v1 had no
 * window at all, which is exactly why its chain table could not be
 * trimmed without changing output.
 *
 * ## Why 90 days
 *
 * Polaris holds the superset and lets each destination narrow to its own
 * vendor window (Meta 7-day click / 1-day view, Google Ads 30-day, GA4
 * 90-day acquisition). A shorter platform window cannot be widened after
 * the fact — we cannot serve data we already discarded — while a longer
 * one is only storage. 90 days sits well inside `analytics_processed`'s
 * 400-day TTL, so a replay can always rebuild a chain the window dropped.
 *
 * SEMANTIC. Changing this value changes which events receive first touch,
 * so it requires a v3 directory with its own manifest — see
 * `docs/architecture/05-processors-and-replay.md` "Processor Versioning".
 */
export const DEFAULT_ATTRIBUTION_WINDOW_SECONDS = 90 * 24 * 60 * 60;

/**
 * Has the chain gone quiet for longer than the window?
 *
 * Compares EVENT time, never wall-clock: a replay of last year's traffic
 * must reach the same verdict as the original live run, which it cannot
 * do if `now()` participates. Pure, exported, and unit-tested for that
 * reason.
 *
 * An unparsable timestamp on either side returns `false` — treating the
 * chain as live. Expiring on a parse failure would silently mint a new
 * first touch, which is the more damaging way to be wrong: it changes
 * attribution, whereas continuing merely postpones a reset until the next
 * well-formed event.
 */
export function isChainExpired(input: {
  readonly last_observed_at: string;
  readonly occurred_at: string;
  readonly window_seconds: number;
}): boolean {
  const last = Date.parse(input.last_observed_at);
  const now = Date.parse(input.occurred_at);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return false;
  // Out-of-order delivery: an event older than the chain's last touch
  // cannot expire it. Guarding here keeps a late arrival from resetting a
  // chain that later events already advanced.
  if (now <= last) return false;
  return now - last > input.window_seconds * 1000;
}

export const PROCESSOR_IDENTITY = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
}) as { readonly name: typeof PROCESSOR_NAME; readonly version: typeof PROCESSOR_VERSION };

/**
 * Kinds of identifier the engine recognises in v1, in PREFERENCE ORDER.
 * The first kind that has a non-empty string value on the envelope's
 * `identity` block is chosen as the primary identifier.
 *
 * Order rationale (mirrors the sessionizer's rule so a session and its
 * attribution chain key on the same identifier):
 *
 *   - `customer_id` is stable across SDK reset() and anonymous rotations.
 *     If present, the chain belongs to that customer regardless of which
 *     anonymous_id the SDK happens to be using right now.
 *
 *   - `anonymous_id` is the SDK's polaris-side persistent identifier.
 *     It rotates on explicit reset() but is stable across page loads
 *     and across SDK session_id rotations.
 *
 *   - `session_id` is the SDK's session hint — it ALREADY rotates after
 *     30 minutes of inactivity. If no other identifier is available we
 *     use the SDK's session_id as the key. Note that this gives a
 *     short-lived attribution scope, which is consistent with v1's
 *     "surface what was observed; don't invent canonical identity"
 *     posture.
 */
export const PRIMARY_IDENTIFIER_KINDS = ["customer_id", "anonymous_id", "session_id"] as const;
export type PrimaryIdentifierKind = (typeof PRIMARY_IDENTIFIER_KINDS)[number];

/**
 * Composite identifier the engine keys touchpoint chains on. Mirrors the
 * `attribution.*` property payloads.
 */
export interface PrimaryIdentifier {
  readonly kind: PrimaryIdentifierKind;
  readonly value: string;
}

/**
 * Wire-stable campaign tuple. The runtime normalises producer-side
 * envelopes (with optional / null / empty-string fields) into this shape
 * so the rest of the pipeline can compare tuples by value equality.
 */
export interface CampaignTuple {
  readonly source: string | null;
  readonly medium: string | null;
  readonly name: string | null;
  readonly term: string | null;
  readonly content: string | null;
  readonly click_id: string | null;
}

/**
 * Resolve the primary identifier the engine keys on. Returns `undefined`
 * when none of the recognised identifiers is present — the runtime drops
 * such events (no touchpoint chain to track).
 */
export function resolvePrimaryIdentifier(
  identity: AttributionEventIdentity,
): PrimaryIdentifier | undefined {
  for (const kind of PRIMARY_IDENTIFIER_KINDS) {
    const value = readIdentityField(identity, kind);
    if (value !== undefined) return { kind, value };
  }
  return undefined;
}

function readIdentityField(
  identity: AttributionEventIdentity,
  kind: PrimaryIdentifierKind,
): string | undefined {
  const value = (identity as unknown as Record<string, unknown>)[kind];
  if (typeof value !== "string") return undefined;
  if (value.length === 0) return undefined;
  return value;
}

/**
 * Compose the canonical store key for an active touchpoint chain.
 * Format: `<project_id>::<environment>::<kind>:<value>`. Mirrors the
 * sessionizer's store-key shape so a future cross-processor join can
 * trivially align sessions and attribution chains.
 */
export function buildTouchpointStoreKey(input: {
  readonly project_id: string;
  readonly environment: string;
  readonly primary: PrimaryIdentifier;
}): string {
  return `${input.project_id}::${input.environment}::${input.primary.kind}:${input.primary.value}`;
}

/**
 * Normalise a producer-side `context.campaign` block into the wire-stable
 * `CampaignTuple`. Empty strings become `null`; missing fields become
 * `null`; falsy non-string values become `null`. Returns the same
 * structural value for inputs that semantically mean "no campaign field
 * here".
 */
export function normaliseCampaign(
  campaign: AttributionEventCampaign | null | undefined,
): CampaignTuple {
  return {
    source: normaliseField(campaign?.source),
    medium: normaliseField(campaign?.medium),
    name: normaliseField(campaign?.name),
    term: normaliseField(campaign?.term),
    content: normaliseField(campaign?.content),
    click_id: normaliseField(campaign?.click_id),
  };
}

function normaliseField(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value;
}

/**
 * True when every field of the campaign tuple is `null`. The engine
 * treats such tuples as "no touchpoint observed" — the source event
 * passes through with no emission. This is the conservative posture:
 * `context.campaign: null` and `context.campaign: { source: null,
 * medium: null, ... }` are semantically equivalent.
 */
export function isCampaignEmpty(tuple: CampaignTuple): boolean {
  return (
    tuple.source === null &&
    tuple.medium === null &&
    tuple.name === null &&
    tuple.term === null &&
    tuple.content === null &&
    tuple.click_id === null
  );
}

/**
 * Compare two campaign tuples for value equality across every field.
 * Used by the delta detector to decide whether a touchpoint observation
 * differs from the prior last-touch tuple.
 */
export function campaignTuplesEqual(a: CampaignTuple, b: CampaignTuple): boolean {
  return (
    a.source === b.source &&
    a.medium === b.medium &&
    a.name === b.name &&
    a.term === b.term &&
    a.content === b.content &&
    a.click_id === b.click_id
  );
}

/**
 * Deterministic `touchpoint_id` derivation. The hash domain-separates
 * attribution-engine v1 from any future processor that might want a
 * similar derivation. Replays of the same `analytics.events` slice
 * produce the same `touchpoint_id` byte-for-byte.
 *
 * The output is `tp_<32-hex-chars>` (128 bits of the SHA-256 digest).
 * Truncating to 128 bits keeps the wire payload short while keeping
 * collision risk negligible at the scale Polaris targets.
 *
 * The hash material is `(source_event_id, canonical_campaign_tuple)`.
 * The source event id is itself a UUIDv7, so different source events
 * produce different ids even when the campaign tuple matches; that
 * keeps `touchpoint_captured` events 1:1 with source observations
 * (every source event with a non-empty campaign produces exactly one
 * touchpoint).
 */
export function deriveTouchpointId(input: {
  readonly source_event_id: string;
  readonly campaign: CampaignTuple;
}): string {
  // Serialise the tuple in a stable field order to avoid hash drift
  // across host platforms / JSON key orderings.
  const tupleString = `source=${input.campaign.source ?? ""}|medium=${
    input.campaign.medium ?? ""
  }|name=${input.campaign.name ?? ""}|term=${input.campaign.term ?? ""}|content=${
    input.campaign.content ?? ""
  }|click_id=${input.campaign.click_id ?? ""}`;
  const material = `polaris/attribution-engine/v2/${input.source_event_id}/${tupleString}`;
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `tp_${digest.slice(0, 32)}`;
}

/**
 * Touchpoint chain record kept in the store. The engine reads
 * the prior record before applying the decision rules, then writes the
 * updated record back.
 */
export interface TouchpointChainRecord {
  readonly project_id: string;
  readonly environment: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  /**
   * `touchpoint_id` of the FIRST observed touchpoint for this
   * identifier. Anchors the first-touch assignment; never changes for
   * the lifetime of the chain.
   */
  readonly first_touchpoint_id: string;
  /**
   * Campaign tuple of the first touchpoint. Kept on the record so the
   * runtime does not need to consult the touchpoint_captured stream to
   * re-emit attribution.first_touch_assigned during recovery.
   */
  readonly first_touchpoint_tuple: CampaignTuple;
  /**
   * Source `event_id` and `occurred_at` of the first touchpoint.
   * Required to re-emit attribution.first_touch_assigned (kept for
   * future replay tooling; runtime emits only once).
   */
  readonly first_source_event_id: string;
  readonly first_observed_at: string;
  /**
   * `touchpoint_id` of the most-recent last-touch assignment. Differs
   * from `first_touchpoint_id` once the chain has had at least one
   * delta observation. The previous_touchpoint_id field on the next
   * last_touch_assigned event mirrors this value.
   */
  readonly last_touchpoint_id: string;
  /** Campaign tuple of the most-recent last-touch assignment. */
  readonly last_touchpoint_tuple: CampaignTuple;
  /** Source `event_id` and `occurred_at` of the most-recent last-touch assignment. */
  readonly last_source_event_id: string;
  readonly last_observed_at: string;
  /** Total touchpoint observations counted (including same-tuple repeats). */
  readonly touchpoint_count: number;
}

/**
 * Decision returned by the pure transform. The runtime interprets:
 *
 *   - `drop` — no usable identifier OR empty campaign; runtime emits
 *     nothing.
 *
 *   - `touchpoint_only` — campaign tuple matches the prior last-touch
 *     tuple. Runtime emits `attribution.touchpoint_captured` only;
 *     no first/last delta event.
 *
 *   - `touchpoint_and_last` — campaign tuple differs from the prior
 *     last-touch tuple but the chain already has a first-touch.
 *     Runtime emits `touchpoint_captured` then `last_touch_assigned`.
 *
 *   - `first_observation` — no prior chain exists. Runtime emits
 *     `touchpoint_captured`, then `first_touch_assigned`, then
 *     `last_touch_assigned` (in that order).
 */
export type AttributionDecision =
  | { readonly kind: "drop" }
  | {
      readonly kind: "touchpoint_only";
      readonly primary: PrimaryIdentifier;
      readonly store_key: string;
      readonly touchpoint_id: string;
      readonly campaign: CampaignTuple;
    }
  | {
      readonly kind: "touchpoint_and_last";
      readonly primary: PrimaryIdentifier;
      readonly store_key: string;
      readonly touchpoint_id: string;
      readonly campaign: CampaignTuple;
      readonly previous_touchpoint_id: string;
    }
  | {
      readonly kind: "first_observation";
      readonly primary: PrimaryIdentifier;
      readonly store_key: string;
      readonly touchpoint_id: string;
      readonly campaign: CampaignTuple;
    };

/**
 * Apply the v1 attribution rules to a touchpoint observation given the
 * prior chain state for the same key (or `undefined` when no chain
 * exists yet).
 */
export function decideAttribution(input: {
  readonly raw: {
    readonly event_id: string;
    readonly occurred_at: string;
    readonly project_id: string;
    readonly environment: string;
    readonly identity: AttributionEventIdentity;
    readonly context: { readonly campaign?: AttributionEventCampaign | null | undefined };
  };
  readonly prior: TouchpointChainRecord | undefined;
  /**
   * Inactivity window in seconds. Defaults to the manifest value; the
   * runtime passes the configured value so an operator can mirror it in
   * env for transparency, never widen it.
   */
  readonly window_seconds?: number;
}): AttributionDecision {
  const primary = resolvePrimaryIdentifier(input.raw.identity);
  if (primary === undefined) return { kind: "drop" };

  const campaign = normaliseCampaign(input.raw.context.campaign);
  if (isCampaignEmpty(campaign)) return { kind: "drop" };

  const storeKey = buildTouchpointStoreKey({
    project_id: input.raw.project_id,
    environment: input.raw.environment,
    primary,
  });
  const touchpointId = deriveTouchpointId({
    source_event_id: input.raw.event_id,
    campaign,
  });

  // An expired chain is treated exactly as an absent one: the journey went
  // quiet for longer than the window, so the next touchpoint starts a new
  // one and earns first touch. This is the single behavioural difference
  // between v1 and v2, and it is deliberately expressed by collapsing to
  // the existing `first_observation` branch rather than adding a fourth
  // decision kind — the emitted events are identical to a genuine first
  // observation, and a separate kind would invite downstream consumers to
  // treat "reset" and "new" differently when nothing about them differs.
  const windowSeconds = input.window_seconds ?? DEFAULT_ATTRIBUTION_WINDOW_SECONDS;
  const expired =
    input.prior !== undefined &&
    isChainExpired({
      last_observed_at: input.prior.last_observed_at,
      occurred_at: input.raw.occurred_at,
      window_seconds: windowSeconds,
    });

  if (input.prior === undefined || expired) {
    return {
      kind: "first_observation",
      primary,
      store_key: storeKey,
      touchpoint_id: touchpointId,
      campaign,
    };
  }

  if (campaignTuplesEqual(campaign, input.prior.last_touchpoint_tuple)) {
    return {
      kind: "touchpoint_only",
      primary,
      store_key: storeKey,
      touchpoint_id: touchpointId,
      campaign,
    };
  }

  return {
    kind: "touchpoint_and_last",
    primary,
    store_key: storeKey,
    touchpoint_id: touchpointId,
    campaign,
    previous_touchpoint_id: input.prior.last_touchpoint_id,
  };
}
