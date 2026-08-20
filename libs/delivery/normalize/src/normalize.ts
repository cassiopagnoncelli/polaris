/**
 * Top-level destination normalization entry point.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * runs:
 *
 *   analytics.events -> consumer subscribes -> NORMALIZE -> MAP -> DELIVER -> RECORD
 *
 * This module owns the NORMALIZE step in its destination-agnostic form.
 * Each consumer composes its own `normalize/` directory on top of this,
 * adding vendor-specific rules (Meta's Gmail `+suffix` stripping, GA4's
 * measurement-protocol shape, etc.). The base layer here:
 *
 *   1. Defensive second-pass redaction (`applySecondPassRedactions`).
 *      The ingester already enforced the platform forbidden-field policy
 *      at intake, but destinations must not assume the canonical event
 *      survived completely clean. A producer may have leaked a token in
 *      `properties` that pattern-redaction caught upstream; an operator
 *      may also have added a project-scoped redaction since intake. The
 *      destination boundary runs the same evaluator one more time, and
 *      treats a redacted-then-empty `properties` as a drop reason so a
 *      catastrophically-redacted event does not produce a degenerate
 *      vendor delivery.
 *
 *   2. Consent gating (`evaluateConsent`). Each destination declares
 *      which consent dimensions it consumes. A `denied` evaluation
 *      surfaces as `{ kind: 'drop', reason: 'consent_not_granted' }`.
 *
 *   3. Identity preparation (`prepareIdentity`). Hashes email/phone here,
 *      not in the vendor mapper. The mapper sees both raw and hashed
 *      forms and picks per vendor.
 *
 *   4. Best-available identity surfacing (via `pickBestIdentity`).
 *      Missing all four identity fields produces
 *      `{ kind: 'drop', reason: 'no_usable_identity' }`.
 *
 *   5. Context flattening (`flattenContext`).
 *
 *   6. Timestamp dual form: `occurred_at` (ISO 8601) +
 *      `occurred_at_epoch_ms` (Unix milliseconds).
 *
 * The result is a `NormalizeOutcome` tagged union: either `{ kind:
 * 'normalized', normalized }` or `{ kind: 'drop', reason, ... }`. Consumers
 * log + drop on `drop`; on `normalized` they proceed to vendor mapping.
 */

import {
  applyRedactions,
  type EventInput,
  evaluate,
  type ProjectPolicyOverride,
  type RedactionAction,
} from "@polaris/governance";

import {
  type ConsentEvaluation,
  type EnvelopeConsent,
  evaluateConsent,
  type RequiredConsent,
} from "./consent.js";
import { type EnvelopeContextInput, type FlatContext, flattenContext } from "./context.js";
import {
  type BestIdentity,
  type IdentityHashingOptions,
  type PreparedIdentity,
  pickBestIdentity,
  prepareIdentity,
  type RawIdentityInput,
} from "./identity.js";
import { isoToEpochMs } from "./timestamp.js";

/**
 * Closed-set drop reasons emitted by the normalizer. Stable across
 * versions; consumers depend on these strings as metric labels and
 * delivery-record outcome codes.
 *
 *   - `consent_not_granted`   one or more declared consent dimensions
 *                            evaluated to `false` (after absent-as-true).
 *   - `no_usable_identity`    `pickBestIdentity` returned `undefined`.
 *   - `invalid_envelope`      essential envelope fields (`event_id`,
 *                            `project_id`, `environment`, `event`,
 *                            `occurred_at`) are missing or malformed.
 *   - `redacted_payload_empty` the second-pass redactor stripped enough
 *                             of `properties` that delivery would be a
 *                             no-op vendor call.
 */
export type DropReason =
  | "consent_not_granted"
  | "no_usable_identity"
  | "invalid_envelope"
  | "redacted_payload_empty";

/** Closed-set list of drop reasons. Useful for exhaustive switches. */
export const DROP_REASONS: readonly DropReason[] = [
  "consent_not_granted",
  "no_usable_identity",
  "invalid_envelope",
  "redacted_payload_empty",
] as const;

/**
 * Envelope shape consumed by the normalizer. Declared structurally so the
 * package does not have to import the heavy Zod schemas. Matches the
 * `Envelope` type in `@polaris/spec` field-for-field; additional
 * fields are tolerated (vendors that need `processor.*` stamps pass them
 * through unchanged).
 *
 * `identity` and `context` mirror the canonical envelope. `properties` is
 * event-owner discretion — the normalizer does not look inside, but may
 * pull `email` / `phone` if the consumer-specific layer maps those slots
 * via `identityFromProperties`.
 */
export interface NormalizableEnvelope {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly identity: {
    readonly anonymous_id?: string | null | undefined;
    readonly session_id?: string | null | undefined;
    readonly customer_id?: string | null | undefined;
    readonly device_id?: string | null | undefined;
  };
  readonly context: EnvelopeContextInput | null;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: EnvelopeConsent | null | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | null | undefined;
  /**
   * Platform resolution of the person, written by the identity stage and
   * completed by enrichment. Optional because it is absent on every
   * envelope that has not been through the spine — `analytics.events`
   * traffic, and any replay of history.
   */
  readonly profile?: EnvelopeProfile | null | undefined;
  /** Platform-derived context, written by the enrichment stage. */
  readonly enrichment?: EnvelopeEnrichment | null | undefined;
}

/** Mirrors `profileBlockSchema` in `@polaris/spec`. */
export interface EnvelopeProfile {
  readonly profile_id: string;
  readonly canonical_customer_id: string | null;
  /**
   * Snapshot taken when the event was enriched, not a live view. `null`
   * covers both "no traits" and "snapshot over the size guard", which the
   * envelope schema deliberately makes the same shape.
   */
  readonly traits?: Readonly<Record<string, unknown>> | null | undefined;
  readonly traits_version?: number | undefined;
}

/** Mirrors `enrichmentBlockSchema` in `@polaris/spec`. */
export interface EnvelopeEnrichment {
  readonly geo?: {
    readonly country: string | null;
    readonly region: string | null;
    readonly city: string | null;
    /** Backend id, or `no_ip` / `no_lookup`. Never absent. */
    readonly source: string;
  } | null;
}

/**
 * Options accepted by `normalizeForDestination`. Each destination
 * declares its own values; the values are usually constants pinned at
 * consumer-version boundary.
 *
 *   - `destinationId`     stable identifier of the destination instance
 *                         (PostgreSQL `destination_id`). Carried through
 *                         to the normalized outcome so delivery records
 *                         can link the outcome to its instance.
 *   - `requiredConsent`   per-dimension consent flags the destination
 *                         requires to be `true` (absent-as-true).
 *   - `identityHashing`   per-PII hashing toggles. Default: hash email +
 *                         phone if present.
 *   - `identityFromProperties`
 *                         optional helper that pulls raw email/phone out
 *                         of `properties` when the producer puts them
 *                         there. Default: read from `identity` only.
 *   - `projectPolicyOverride`
 *                         project-level override for the second-pass
 *                         redaction. The platform default policy already
 *                         applies; this is for project-scoped tightening.
 */
export interface NormalizeOptions {
  readonly destinationId: string;
  readonly requiredConsent: RequiredConsent;
  readonly identityHashing?: IdentityHashingOptions;
  readonly identityFromProperties?: (
    properties: Readonly<Record<string, unknown>>,
  ) => Pick<RawIdentityInput, "email" | "phone"> | undefined;
  readonly projectPolicyOverride?: ProjectPolicyOverride;
}

/**
 * Successful normalization outcome. The shape is what every vendor
 * mapper consumes — they map this into their vendor payload schema.
 */
export interface NormalizedEvent {
  readonly destination_id: string;
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;

  /** ISO 8601 UTC timestamp (same as `envelope.occurred_at`). */
  readonly occurred_at: string;
  /** Unix epoch milliseconds parsed from `occurred_at`. */
  readonly occurred_at_epoch_ms: number;
  /** ISO 8601 UTC timestamp (same as `envelope.ingested_at`). */
  readonly ingested_at: string;

  readonly identity: PreparedIdentity;
  /** Best-available identity per the `user_id > email > phone > anonymous` rule. */
  readonly best_identity: BestIdentity;

  readonly context: FlatContext;

  /** Defensively-redacted properties (cloned; original is untouched). */
  readonly properties: Readonly<Record<string, unknown>>;

  /** Consent evaluation snapshot for observability. */
  readonly consent: ConsentEvaluation;

  /**
   * Profile traits as of enrichment, redacted and hashed on exactly the
   * same rules as `properties`.
   *
   * That equality is the point. Traits reach a vendor through the same
   * boundary as producer properties and carry the same kind of data — an
   * email in `traits.email` is the same email as in `properties.email` —
   * so a weaker rule here would be a hole cut in the redaction policy by
   * way of the profile store. `null` when the envelope carries no traits.
   */
  readonly traits: Readonly<Record<string, unknown>> | null;
  /** Version of the traits snapshot; `null` when there are no traits. */
  readonly traits_version: number | null;

  /**
   * Platform-derived context. Exposed so a mapper can send a vendor a
   * country without the consumer re-deriving one from an IP that
   * normalization has already redacted.
   */
  readonly enrichment: NormalizedEnrichment;
}

/** The enrichment surface handed to mappers. */
export interface NormalizedEnrichment {
  readonly geo: {
    readonly country: string | null;
    readonly region: string | null;
    readonly city: string | null;
    readonly source: string;
  } | null;
}

/** Successful outcome of `normalizeForDestination`. */
export interface NormalizedOutcome {
  readonly kind: "normalized";
  readonly normalized: NormalizedEvent;
}

/** Drop outcome (declared closed-set). */
export interface DropOutcome {
  readonly kind: "drop";
  readonly reason: DropReason;
  /** Per-drop diagnostic detail; label-safe and value-free. */
  readonly detail?: string;
}

/** Tagged-union outcome of `normalizeForDestination`. */
export type NormalizeOutcome = NormalizedOutcome | DropOutcome;

/**
 * Normalize a canonical envelope for destination delivery.
 *
 * Pure, stateless, no network. The returned outcome is either a
 * `NormalizedOutcome` (the mapper proceeds) or a `DropOutcome` (the
 * consumer logs the reason and drops). The envelope is **never mutated**;
 * the redactor clones before applying.
 */
export function normalizeForDestination(
  envelope: NormalizableEnvelope,
  options: NormalizeOptions,
): NormalizeOutcome {
  // 1. Envelope conformance check. Defensive: the ingester already
  // validated the envelope shape, but a malformed replay payload or a
  // future processor with a bug could deliver something incomplete.
  const invalid = invalidEnvelopeReason(envelope);
  if (invalid !== null) {
    return { kind: "drop", reason: "invalid_envelope", detail: invalid };
  }

  // 2. Second-pass redaction. Runs the same `@polaris/governance`
  // evaluator the ingester used; project overrides may have tightened
  // the policy between intake and delivery. The redactor is read-only on
  // the input; we clone the envelope subtree we hand downstream.
  const redaction = applySecondPassRedactions(envelope, options.projectPolicyOverride);
  if (redaction.kind === "reject") {
    // A reject decision means a forbidden field appeared in the event
    // *after* ingestion (e.g. a project override flipped a field from
    // redact to reject post-intake). At the destination boundary we
    // treat this as `redacted_payload_empty` — the event is in a state
    // the policy forbids and we should not deliver it.
    return {
      kind: "drop",
      reason: "redacted_payload_empty",
      detail: `policy reject post-intake at path ${redaction.path.join(".")}`,
    };
  }
  const redactedEnvelope = redaction.envelope;

  // 3. Consent gating.
  const consentEval = evaluateConsent(redactedEnvelope.consent ?? null, options.requiredConsent);
  if (consentEval.status === "denied") {
    return {
      kind: "drop",
      reason: "consent_not_granted",
      detail: `dimension ${consentEval.deniedBy}`,
    };
  }

  // 4. Identity preparation. Pull raw email/phone via the destination's
  // optional `identityFromProperties` hook; default is to read from the
  // canonical `identity` block only.
  const propsIdentity = options.identityFromProperties?.(redactedEnvelope.properties);
  const profile = redactedEnvelope.profile ?? null;
  const identityInput: RawIdentityInput = {
    canonical_customer_id: profile?.canonical_customer_id ?? null,
    profile_id: profile?.profile_id ?? null,
    user_id: redactedEnvelope.identity.customer_id ?? null,
    anonymous_id: redactedEnvelope.identity.anonymous_id ?? null,
    ...(propsIdentity ?? {}),
  };
  const identity = prepareIdentity(identityInput, options.identityHashing ?? {});

  // 5. Best-available identity. No usable identity → drop.
  const best = pickBestIdentity(identity);
  if (best === undefined) {
    return { kind: "drop", reason: "no_usable_identity" };
  }

  // 6. Context flattening.
  const context = flattenContext(redactedEnvelope.context);

  // 7. Timestamps. The envelope-validation step in `invalidEnvelopeReason`
  // already guards against malformed strings, so `isoToEpochMs` does not
  // throw here in production.
  const occurredAtEpochMs = isoToEpochMs(redactedEnvelope.occurred_at);

  const normalized: NormalizedEvent = {
    destination_id: options.destinationId,
    event_id: redactedEnvelope.event_id,
    event: redactedEnvelope.event,
    schema_version: redactedEnvelope.schema_version,
    project_id: redactedEnvelope.project_id,
    environment: redactedEnvelope.environment,
    occurred_at: redactedEnvelope.occurred_at,
    occurred_at_epoch_ms: occurredAtEpochMs,
    ingested_at: redactedEnvelope.ingested_at,
    identity,
    best_identity: best,
    context,
    properties: redactedEnvelope.properties,
    consent: consentEval,
    traits: normalizeTraits(profile?.traits ?? null, options.identityHashing ?? {}),
    traits_version:
      profile?.traits === undefined || profile.traits === null
        ? null
        : (profile.traits_version ?? null),
    enrichment: { geo: redactedEnvelope.enrichment?.geo ?? null },
  };

  return { kind: "normalized", normalized };
}

/**
 * Trait keys carrying PII the identity layer knows how to hash.
 *
 * Deliberately the same two the identity layer handles and no more. A
 * broader guess — hashing anything whose key contains "mail", say — would
 * hash a `mailing_preference` string into noise, and an operator would have
 * no way to tell a hashed trait from a genuinely opaque one.
 */
const HASHABLE_TRAIT_KEYS = { email: "email", phone: "phone" } as const;

/**
 * Apply the identity layer's hashing rules to a traits snapshot.
 *
 * `traits.email` is the same class of value as an `identity.email`, so it
 * obeys the same per-destination toggle: a vendor that receives hashed
 * email in its identity block must not receive the plaintext of the same
 * address one field over, which is exactly what a passthrough would do.
 *
 * A value that fails to hash (a non-E.164 phone) is DROPPED from the
 * output rather than passed through raw. Traits are a convenience surface;
 * leaking a plaintext phone because it was badly formatted is not a
 * trade-off worth making, and the raw value remains available on
 * `identity.phone` when a mapper genuinely needs to re-attempt it.
 */
function normalizeTraits(
  traits: Readonly<Record<string, unknown>> | null,
  hashing: IdentityHashingOptions,
): Readonly<Record<string, unknown>> | null {
  if (traits === null) return null;

  const prepared = prepareIdentity(
    {
      email:
        typeof traits[HASHABLE_TRAIT_KEYS.email] === "string"
          ? (traits[HASHABLE_TRAIT_KEYS.email] as string)
          : null,
      phone:
        typeof traits[HASHABLE_TRAIT_KEYS.phone] === "string"
          ? (traits[HASHABLE_TRAIT_KEYS.phone] as string)
          : null,
    },
    hashing,
  );

  const out: Record<string, unknown> = { ...traits };
  applyHashedTrait(out, HASHABLE_TRAIT_KEYS.email, prepared.email_sha256, hashing.email !== false);
  applyHashedTrait(out, HASHABLE_TRAIT_KEYS.phone, prepared.phone_sha256, hashing.phone !== false);
  return out;
}

function applyHashedTrait(
  out: Record<string, unknown>,
  key: string,
  hashed: string | null,
  enabled: boolean,
): void {
  if (!enabled) return;
  if (out[key] === undefined) return;
  if (hashed === null) {
    // Present but unhashable. Removing it is the conservative branch: see
    // `normalizeTraits`.
    delete out[key];
    return;
  }
  delete out[key];
  out[`${key}_sha256`] = hashed;
}

/**
 * Outcome of `applySecondPassRedactions`.
 *
 * `redactions` is always populated on the `redacted` path (possibly
 * empty). The consumer runtime forwards the entries to
 * `@polaris/governance`'s `emitRedactionMetric` so pattern-based
 * redactions emit `polaris_ingest_redacted_pattern_total` with the same
 * label set ingestion uses. The redaction actions never carry the raw
 * pre-redaction value — the evaluator only retains the path, reason,
 * source, and replacement sentinel.
 */
export type SecondPassRedactionOutcome<T extends NormalizableEnvelope> =
  | {
      readonly kind: "redacted";
      readonly envelope: T;
      readonly redactions: readonly RedactionAction[];
    }
  | { readonly kind: "reject"; readonly path: readonly string[] };

/**
 * Run the platform forbidden-field evaluator one more time at the
 * destination boundary. The platform default policy applies; an optional
 * project override may tighten it.
 *
 * Returns either:
 *   - `{ kind: 'redacted', envelope, redactions }` — the (possibly
 *     cloned) envelope to hand to the mapper, plus the redaction actions
 *     applied. The consumer runtime forwards `redactions` to
 *     `emitRedactionMetric` so pattern-based redactions emit the
 *     `polaris_ingest_redacted_pattern_total` metric. When the evaluator
 *     returned zero redactions the original envelope reference is
 *     returned (no needless clone) and `redactions` is the empty array.
 *   - `{ kind: 'reject', path }` — a forbidden field appeared at this
 *     boundary that the policy forbids. The destination drops with
 *     `redacted_payload_empty`.
 */
export function applySecondPassRedactions<T extends NormalizableEnvelope>(
  envelope: T,
  projectPolicyOverride?: ProjectPolicyOverride,
): SecondPassRedactionOutcome<T> {
  // The policy evaluator works on a structural `EventInput` shape
  // (`Readonly<Record<string, unknown>>`). `NormalizableEnvelope` carries
  // strict typed fields; TS does not add an implicit index signature, so
  // we cross the boundary with an explicit `EventInput` cast. The
  // evaluator never mutates `envelope` (see `evaluator.ts` "does not
  // mutate the input event"), so the cast is read-only.
  const policyInput = envelope as unknown as EventInput;
  const decision = evaluate(
    policyInput,
    projectPolicyOverride ? { projectPolicy: projectPolicyOverride } : {},
  );
  if (decision.decision === "reject") {
    return { kind: "reject", path: decision.path };
  }
  if (decision.redactions.length === 0) {
    return { kind: "redacted", envelope, redactions: EMPTY_REDACTIONS };
  }
  // `applyRedactions` returns the input type it was handed; we hand it
  // the `EventInput`-typed reference and recover the original `T`.
  const cloned = applyRedactions(policyInput, decision.redactions) as unknown as T;
  return { kind: "redacted", envelope: cloned, redactions: decision.redactions };
}

const EMPTY_REDACTIONS: readonly RedactionAction[] = Object.freeze([]);

function invalidEnvelopeReason(envelope: NormalizableEnvelope): string | null {
  if (typeof envelope !== "object" || envelope === null) return "envelope is not an object";
  if (typeof envelope.event_id !== "string" || envelope.event_id.length === 0) {
    return "event_id is missing";
  }
  if (typeof envelope.event !== "string" || envelope.event.length === 0) {
    return "event is missing";
  }
  if (typeof envelope.project_id !== "string" || envelope.project_id.length === 0) {
    return "project_id is missing";
  }
  if (typeof envelope.environment !== "string" || envelope.environment.length === 0) {
    return "environment is missing";
  }
  if (typeof envelope.occurred_at !== "string" || envelope.occurred_at.length === 0) {
    return "occurred_at is missing";
  }
  if (typeof envelope.ingested_at !== "string" || envelope.ingested_at.length === 0) {
    return "ingested_at is missing";
  }
  if (typeof envelope.schema_version !== "number" || !Number.isInteger(envelope.schema_version)) {
    return "schema_version is missing";
  }
  const parsed = Date.parse(envelope.occurred_at);
  if (!Number.isFinite(parsed)) return "occurred_at is not a parseable ISO 8601 UTC string";
  if (typeof envelope.identity !== "object" || envelope.identity === null) {
    return "identity block missing";
  }
  if (
    envelope.properties === undefined ||
    envelope.properties === null ||
    typeof envelope.properties !== "object"
  ) {
    return "properties block missing";
  }
  return null;
}
