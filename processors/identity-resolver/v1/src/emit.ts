/**
 * Canonical `identity.events` envelope builder for identity-resolver v1.
 *
 * The runtime drives the resolver and decides which of the three governed
 * identity events to emit. This module turns that decision into a
 * canonical platform envelope ready for `PolarisProducer.publishEvent`.
 *
 * Envelope rules (per `docs/architecture/01-event-contract.md`):
 *
 *   - top-level shape is the canonical envelope,
 *   - `project_id` and `environment` are inherited from the source raw
 *     event (the identity event is scoped to the same project/environment
 *     as the observation),
 *   - `occurred_at` mirrors the source event's `occurred_at` so the
 *     identity event lands on the same timeline as the observation that
 *     triggered it,
 *   - `ingested_at` is stamped at emission time by the resolver (the
 *     event was technically "ingested" by the identity processor),
 *   - the `source` block carries the resolver's own identity:
 *     `{ type: "internal", id: "identity-resolver" }` so downstream
 *     consumers can tell the event came from the platform, not a
 *     producer,
 *   - the `identity` block carries the same identifiers the source event
 *     carried — never invented ones,
 *   - the `context` block is empty (the resolver does not see browser
 *     context),
 *   - `properties` is the per-event-name property payload (validated by
 *     the Zod schemas in `@polaris/shared-schemas/events/identity/`).
 *
 * The processor stamp is delegated to
 * `@polaris/shared-processor`'s `stampProcessorMetadata` helper so every
 * Polaris processor produces the same dual-shape envelope (nested
 * `processor` block + flat `processor_name` / `processor_version`).
 */

import { type ProcessorStamp, stampProcessorMetadata } from "@polaris/shared-processor";

import type { IdentityLinkRecord } from "./repository.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, type PROCESSOR_VERSION } from "./transform.js";
import type { RawEventEnvelope, RawEventIdentity } from "./types.js";

/** Names of the three governed identity events v1 emits. */
export type IdentityEventName = "identity.linked" | "identity.merged" | "identity.rotated";

/**
 * Outcome of applying the explicit-overlap rule. The runtime computes
 * this; the envelope builder reads from it.
 */
export interface IdentityEventEmission {
  readonly event_name: IdentityEventName;
  /** Newly inserted (or already-active) `identity_links` row. */
  readonly link: IdentityLinkRecord;
  /**
   * Superseded `identity_links` row, present only for merge/rotation
   * emissions. The runtime supersedes the prior row in the same call.
   */
  readonly superseded?: IdentityLinkRecord | undefined;
  /**
   * `true` when the link already existed and the resolver did not insert
   * a new row. The event is still emitted for downstream lineage, but
   * the property payload references the existing row's `link_id`.
   */
  readonly idempotent: boolean;
}

/**
 * Source identifier stamped on every `identity.events` envelope emitted
 * by this processor. The `type: "internal"` flag tells downstream
 * consumers (audit, dashboards) that the event was produced by the
 * platform itself, not by a producer SDK.
 */
const RESOLVER_SOURCE = Object.freeze({
  type: "internal" as const,
  id: PROCESSOR_NAME,
  sdk: null,
  sdk_version: null,
});

/** Empty canonical context block — the resolver has no browser context. */
const EMPTY_CONTEXT = Object.freeze({
  ip: null,
  user_agent: null,
  locale: null,
  page: null,
  campaign: null,
});

/**
 * Output envelope shape. The emit module produces the closed audited
 * shape; the producer widens at the publish boundary so this type stays
 * narrow.
 */
export interface IdentityEventEnvelope {
  readonly event_id: string;
  readonly event: IdentityEventName;
  readonly schema_version: 1;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: typeof RESOLVER_SOURCE;
  readonly identity: RawEventIdentity;
  readonly context: typeof EMPTY_CONTEXT;
  readonly properties: IdentityEventProperties;
  // Dual-shape processor stamp (nested + flat columns) — same shape as
  // analytics-projector's emission so ClickHouse Kafka Engine ingestion
  // can read both.
  readonly processor: ProcessorStamp;
  readonly processor_name: typeof PROCESSOR_NAME;
  readonly processor_version: typeof PROCESSOR_VERSION;
}

/**
 * Properties payload union. The shape per event name mirrors the Zod
 * schemas in `@polaris/shared-schemas/events/identity/`.
 */
export type IdentityEventProperties =
  | IdentityLinkedProperties
  | IdentityMergedProperties
  | IdentityRotatedProperties;

export interface IdentityLinkedProperties {
  readonly link_id: string;
  readonly confidence: "authoritative" | "candidate";
  readonly left_identifier: string;
  readonly right_identifier: string;
  readonly evidence_type: string;
  readonly evidence: Record<string, unknown>;
  readonly reason: string;
  readonly run_id: string;
}

export interface IdentityMergedProperties {
  readonly link_id: string;
  readonly new_identifier: string;
  readonly shared_identifier: string;
  readonly superseded_identifier: string;
  readonly superseded_link_id: string;
  readonly reason: string;
  readonly run_id: string;
}

export interface IdentityRotatedProperties {
  readonly link_id: string;
  readonly stable_identifier: string;
  readonly new_identifier: string;
  readonly previous_identifier: string;
  readonly reason: string;
  readonly run_id: string;
}

/** Options accepted by `buildIdentityEventEnvelope`. */
export interface BuildIdentityEventEnvelopeOptions {
  readonly raw: RawEventEnvelope;
  readonly emission: IdentityEventEmission;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id?: string | undefined;
}

/**
 * Build the canonical envelope for the resolver's chosen identity event.
 *
 * The function is pure (no I/O). `now` controls `ingested_at` and the
 * processor stamp's `ran_at`. The caller passes a deterministic clock in
 * golden-fixture tests.
 */
export function buildIdentityEventEnvelope(
  options: BuildIdentityEventEnvelopeOptions,
): IdentityEventEnvelope {
  const { raw, emission, eventId, now } = options;
  const runId =
    options.run_id ?? emission.link.run_id ?? buildSyntheticRunId(emission.link.link_id);
  const ingestedAt = now().toISOString();

  const properties = buildPropertiesPayload(emission, runId);

  const baseEnvelope = {
    event_id: eventId,
    event: emission.event_name,
    schema_version: 1 as const,
    project_id: raw.project_id,
    environment: raw.environment,
    occurred_at: raw.occurred_at,
    ingested_at: ingestedAt,
    source: RESOLVER_SOURCE,
    identity: raw.identity,
    context: EMPTY_CONTEXT,
    properties,
  };

  const stamped = stampProcessorMetadata(baseEnvelope, {
    identity: PROCESSOR_IDENTITY,
    now,
    ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
  });

  return stamped as unknown as IdentityEventEnvelope;
}

function buildPropertiesPayload(
  emission: IdentityEventEmission,
  runId: string,
): IdentityEventProperties {
  if (emission.event_name === "identity.linked") {
    return {
      link_id: emission.link.link_id,
      confidence: emission.link.confidence,
      left_identifier: emission.link.left_identifier,
      right_identifier: emission.link.right_identifier,
      evidence_type: emission.link.evidence_type,
      evidence: emission.link.evidence,
      reason: emission.link.reason,
      run_id: runId,
    } satisfies IdentityLinkedProperties;
  }
  if (emission.event_name === "identity.merged") {
    const superseded = requireSuperseded(emission);
    const shared = sharedIdentifier(emission.link, superseded);
    const newCounterpart = otherIdentifier(emission.link, shared);
    const supersededCounterpart = otherIdentifier(superseded, shared);
    return {
      link_id: emission.link.link_id,
      new_identifier: newCounterpart,
      shared_identifier: shared,
      superseded_identifier: supersededCounterpart,
      superseded_link_id: superseded.link_id,
      reason: emission.link.reason,
      run_id: runId,
    } satisfies IdentityMergedProperties;
  }
  // identity.rotated
  const superseded = requireSuperseded(emission);
  const stable = sharedIdentifier(emission.link, superseded);
  const newRotating = otherIdentifier(emission.link, stable);
  const previousRotating = otherIdentifier(superseded, stable);
  return {
    link_id: emission.link.link_id,
    stable_identifier: stable,
    new_identifier: newRotating,
    previous_identifier: previousRotating,
    reason: emission.link.reason,
    run_id: runId,
  } satisfies IdentityRotatedProperties;
}

function requireSuperseded(emission: IdentityEventEmission): IdentityLinkRecord {
  if (emission.superseded === undefined) {
    throw new Error(
      `identity-resolver: ${emission.event_name} emission requires a superseded link`,
    );
  }
  return emission.superseded;
}

/**
 * Find the identifier present in both `a` and `b`. The runtime ensures
 * there is exactly one shared identifier across the two rows when a
 * merge/rotation is detected.
 */
function sharedIdentifier(a: IdentityLinkRecord, b: IdentityLinkRecord): string {
  if (a.left_identifier === b.left_identifier || a.left_identifier === b.right_identifier) {
    return a.left_identifier;
  }
  if (a.right_identifier === b.left_identifier || a.right_identifier === b.right_identifier) {
    return a.right_identifier;
  }
  throw new Error(`identity-resolver: link rows ${a.link_id} and ${b.link_id} share no identifier`);
}

function otherIdentifier(row: IdentityLinkRecord, shared: string): string {
  if (row.left_identifier === shared) return row.right_identifier;
  if (row.right_identifier === shared) return row.left_identifier;
  throw new Error(
    `identity-resolver: link row ${row.link_id} does not carry the shared identifier "${shared}"`,
  );
}

/**
 * Generate a synthetic run id when the runtime has not been wired to the
 * `ProcessorRunRepository` yet. The run id is intentionally derived from
 * the link id (UUIDv7) so it stays stable across replays of the same
 * event, but it is NOT a registered run row. The boot layer should always
 * pass an explicit `run_id` once P8-001 wiring lands in deployment.
 */
function buildSyntheticRunId(linkId: string): string {
  return `synthetic:${linkId}`;
}
