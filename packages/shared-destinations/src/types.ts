/**
 * Public types of the destination consumer runtime.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * runs the three-stage pipeline:
 *
 *   analytics.events -> subscribe -> NORMALIZE -> MAP -> DELIVER -> RECORD
 *
 * This module pins the TypeScript surface for the per-stage contracts that
 * vendor consumers (`consumers/<vendor>/v<N>/`) implement. The runtime
 * (`./runtime.ts`) composes those contracts into a single PolarisConsumer
 * loop and writes the resulting delivery_records / DLQ entries.
 *
 * Each stage is independently versioned. The runtime carries each stage's
 * version into the delivery record so a `normalize/v1 -> normalize/v2`
 * transition is auditable without bumping the whole consumer version.
 *
 * Hard rules baked into the type surface:
 *
 *   - **Mappers receive the normalized intermediate, NEVER the raw envelope.**
 *     The `MapperContext` shape carries `normalized` (a `NormalizedEvent`
 *     from `@polaris/shared-destination-normalize`) and the destination
 *     instance, but it does NOT carry the raw envelope. A mapper that wants
 *     raw PII cannot reach it through this API — the type system rejects
 *     the call. Tests in `test/mapper-no-raw-pii.test.ts` lock the surface.
 *
 *   - **Deliverers see the mapped vendor payload, NEVER the canonical
 *     event.** The `DelivererContext` carries the mapped payload plus the
 *     destination instance and a resolved secret (a plain string). It does
 *     not carry the raw or normalized event.
 *
 *   - **Deliverers receive a resolved secret as a plain `string`, never a
 *     reference.** Secret resolution happens at the runtime boundary so
 *     the vendor code does not have to reach into `@polaris/shared-secrets`.
 *     The plaintext lives in memory for the duration of one delivery
 *     attempt and is not retained by the runtime.
 */

import type {
  IdentityHashingOptions,
  NormalizableEnvelope,
  NormalizedEvent,
  RawIdentityInput,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";
import type { DeliveryRecordErrorClass } from "./db/delivery-records.js";
import type { DestinationInstance } from "./db/destination-instance.js";

/**
 * The minimum identity fields the runtime needs from a "consumer
 * descriptor" — a static declaration of a vendor consumer that the runtime
 * binds to.
 *
 *   - `vendor`              the vendor literal from the consumer manifest,
 *                           stamped onto every delivery record.
 *   - `component`           the consumer's queue-topology name.
 *   - `consumerVersion`     immutable version directory under the vendor.
 *   - `normalizeVersion`    per-vendor normalize-stage version.
 *   - `mapperVersion`       per-vendor mapper-stage version.
 *   - `delivererVersion`    per-vendor deliverer-stage version.
 *
 * The four version strings are stamped onto every delivery record so an
 * audit trail can scope to "all records produced with normalize/v2 against
 * deliverer/v1". The vendor's directory tree on disk is the source of
 * truth for which versions actually exist; the runtime does not validate
 * the literals against the tree.
 *
 * `component` is separate from `vendor` because the two are not always the
 * same string: webhook-sink's vendor is `webhook` (webhooks are
 * vendor-agnostic) while its queue set is `webhook-sink.*`. It must match
 * an entry in `POLARIS_COMPONENTS` — that list is what
 * `pnpm rabbitmq:provision` declares, and a DLQ publish to an undeclared
 * queue is discarded by the broker without an error.
 */
export interface ConsumerIdentity {
  readonly vendor: string;
  readonly component: string;
  readonly consumerVersion: string;
  readonly normalizeVersion: string;
  readonly mapperVersion: string;
  readonly delivererVersion: string;
}

/**
 * Per-vendor mapping from canonical event name to the mapper that converts
 * a `NormalizedEvent` into the vendor's payload shape.
 *
 *   - The key is the canonical event name (e.g. `payment.approved`).
 *   - The value is the mapper function. Mappers are pure: they must not
 *     read raw canonical PII (the `MapperContext` does not carry it),
 *     must not call out to the network, and must not depend on state
 *     outside the input.
 *
 * The runtime looks up the mapper by `normalized.event`. A missing mapper
 * is a `mapped_failed` delivery record with `error_class='mapping'` —
 * vendors are expected to fail loudly on unsupported events rather than
 * silently dropping. Vendors that legitimately don't ship a mapping for
 * an event provide one that returns `{ kind: 'skip', reason }` (see
 * `MapperResult` below).
 */
export type MapperMap<Payload> = Readonly<Record<string, Mapper<Payload>>>;

/**
 * Mapper context. The `normalized` field comes from
 * `normalizeForDestination`; `instance` is the destination row at attempt
 * time. The mapper picks vendor-specific fields out of the normalized
 * shape and assembles the vendor payload.
 *
 * The shape intentionally does NOT carry the raw envelope. Tests lock
 * this rule.
 */
export interface MapperContext {
  readonly normalized: NormalizedEvent;
  readonly instance: DestinationInstance;
}

/**
 * Outcome of one mapper call. Two shapes:
 *
 *   - `{ kind: 'mapped', payload, dedupe_key? }` — the vendor payload is
 *     ready; the runtime hands it to the deliverer.
 *   - `{ kind: 'skip', reason }` — this event is intentionally not
 *     delivered by this vendor. The runtime writes a
 *     `mapped_failed` record with the supplied reason but does NOT
 *     republish to the DLQ; this is a planned-skip path (e.g. vendor
 *     does not consume `experimental.*`).
 *
 * Vendor-specific dedupe keys (Meta `event_id`, GA4 `transaction_id`,
 * etc.) live in `dedupe_key`. The runtime forwards the value onto the
 * delivery record and uses it for vendor dedupe lookups. Mappers that
 * don't produce a dedupe key leave the field undefined.
 */
export type MapperResult<Payload> =
  | { readonly kind: "mapped"; readonly payload: Payload; readonly dedupe_key?: string }
  | { readonly kind: "skip"; readonly reason: string };

/** Mapper function signature. Pure. No I/O. */
export type Mapper<Payload> = (context: MapperContext) => MapperResult<Payload>;

/**
 * Deliverer context. Carries the mapped payload, the destination instance
 * row, and the RESOLVED secret value as a plain string.
 *
 * The runtime resolves the secret per attempt and zeroes-out its in-memory
 * lifetime to the duration of one deliverer call. Deliverers MUST NOT
 * retain the secret beyond the call; the runtime does not enforce this in
 * v1, but the operational expectation is documented and tests assert the
 * runtime does not log the value.
 */
export interface DelivererContext<Payload> {
  readonly payload: Payload;
  readonly instance: DestinationInstance;
  readonly secret: string;
  /**
   * Vendor-side dedupe key supplied by the mapper. Forwarded onto the
   * delivery record so the runtime can short-circuit vendor-dedupe lookups
   * before the next attempt.
   */
  readonly dedupe_key?: string;
  /**
   * 1-based attempt counter. Useful for deliverers that want to attach a
   * `Polaris-Attempt: <n>` header for vendor-side correlation.
   */
  readonly attempt: number;
  /**
   * Polaris delivery key — stable across attempts. Useful for deliverers
   * that map this onto a vendor's `event_id` / `client_id` / similar field
   * when no mapper-supplied `dedupe_key` is present.
   */
  readonly delivery_key: string;
}

/**
 * Outcome of one deliverer call. Three shapes:
 *
 *   - `{ kind: 'accepted', vendor_response_code?, vendor_response_summary?
 *      }`
 *     Vendor returned a 2xx-equivalent success. The runtime writes an
 *     `accepted` record (no `error_class`).
 *
 *   - `{ kind: 'failed_retryable', error_class, vendor_response_code?,
 *      vendor_response_summary? }`
 *     Transient failure. The runtime writes a `failed_retryable` record,
 *     re-throws so KafkaJS retries through its own consumer retry
 *     semantics, and (on dead-letter threshold) republishes to the DLQ.
 *
 *   - `{ kind: 'failed_permanent', error_class, vendor_response_code?,
 *      vendor_response_summary? }`
 *     Permanent failure (vendor 4xx, auth failure). The runtime writes a
 *     `failed_permanent` record and republishes straight to the DLQ
 *     without further retries.
 *
 * `error_class` must be one of the closed-set `DeliveryRecordErrorClass`
 * values. The DLQ headers and dashboards filter on it.
 */
export type DelivererResult =
  | {
      readonly kind: "accepted";
      readonly vendor_response_code?: string;
      readonly vendor_response_summary?: string;
    }
  | {
      readonly kind: "failed_retryable";
      readonly error_class: DeliveryRecordErrorClass;
      readonly vendor_response_code?: string;
      readonly vendor_response_summary?: string;
    }
  | {
      readonly kind: "failed_permanent";
      readonly error_class: DeliveryRecordErrorClass;
      readonly vendor_response_code?: string;
      readonly vendor_response_summary?: string;
    };

/**
 * Deliverer function signature. The only stage that talks to the network.
 *
 * The runtime does NOT introspect a thrown error — deliverers are expected
 * to catch their own network errors and return a `failed_retryable` /
 * `failed_permanent` result with the appropriate `error_class`. If a
 * deliverer DOES throw, the runtime catches and classifies the error via
 * `@polaris/shared-processor`'s `classifyError`, but that path is a
 * fallback for unexpected exceptions (e.g. a programmer bug in the
 * deliverer code).
 */
export type Deliverer<Payload> = (context: DelivererContext<Payload>) => Promise<DelivererResult>;

/**
 * Full descriptor of a vendor destination consumer. Vendors construct one
 * of these and hand it to `DestinationConsumer` (or to the runtime's
 * factory function).
 *
 * The descriptor is the contract between the vendor's
 * `consumers/<vendor>/v<N>/` code and the shared runtime. Vendors override
 * mappers / deliverer / required-consent / identity-hashing here.
 */
export interface DestinationDescriptor<Payload> {
  /** Static identity of the vendor + per-stage versions. */
  readonly identity: ConsumerIdentity;
  /** Per-canonical-event mapper map. Vendors fail loudly on missing entries. */
  readonly mappers: MapperMap<Payload>;
  /** The single deliverer function for the consumer. */
  readonly deliverer: Deliverer<Payload>;
  /**
   * Vendor-declared consent requirements. Forwarded into
   * `normalizeForDestination` as `requiredConsent`. Use `{}` for "no
   * vendor-declared consent gating".
   */
  readonly requiredConsent: RequiredConsent;
  /**
   * Per-vendor identity hashing toggles. Defaults to hash-everything.
   * Vendors that consume raw email (rare; most require hashed) override
   * this.
   */
  readonly identityHashing?: IdentityHashingOptions;
  /**
   * Optional helper to extract email / phone from `properties`. Used when
   * the producer puts these in `properties` rather than the canonical
   * `identity` block.
   */
  readonly identityFromProperties?: (
    properties: Readonly<Record<string, unknown>>,
  ) => Pick<RawIdentityInput, "email" | "phone"> | undefined;
}

/**
 * Drop-outcome reason emitted by the normalizer. The runtime translates
 * each drop reason into a `DeliveryRecordStatus` for the
 * `delivery_records` row:
 *
 *   - `consent_not_granted`     -> `dropped_consent`     / `error_class='consent'`
 *   - `no_usable_identity`      -> `dropped_no_identity` / `error_class='identity'`
 *   - `invalid_envelope`        -> `dropped_invalid`     / `error_class='policy'`
 *   - `redacted_payload_empty`  -> `dropped_invalid`     / `error_class='policy'`
 */
export type RuntimeDropReason =
  | "consent_not_granted"
  | "no_usable_identity"
  | "invalid_envelope"
  | "redacted_payload_empty";

/** Envelope passed into the runtime's `handleEvent`. Re-exported for vendor code. */
export type { NormalizableEnvelope, NormalizedEvent };
