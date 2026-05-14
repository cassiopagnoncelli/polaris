/**
 * Canonical `attribution.events` envelope builder for attribution-engine v1.
 *
 * The runtime drives the engine and decides which attribution events to
 * emit (one, two, or three per source event — see `transform.ts`
 * `AttributionDecision`). This module turns those decisions into
 * canonical platform envelopes ready for the producer.
 *
 * Envelope rules (per `docs/architecture/01-event-contract.md`):
 *
 *   - top-level shape is the canonical envelope,
 *   - `project_id` and `environment` are inherited from the source event
 *     (the attribution event is scoped to the same project/environment
 *     as the observation),
 *   - `occurred_at` mirrors the source event's `occurred_at` so the
 *     attribution event lands on the same timeline as the observation
 *     that triggered it,
 *   - `ingested_at` is stamped at emission time by the engine,
 *   - the `source` block carries the processor's own identity:
 *     `{ type: "internal", id: "attribution-engine" }` so downstream
 *     consumers can tell the event came from the platform, not a
 *     producer,
 *   - the `identity` block mirrors the source event's identity layer
 *     (so analytics keeping a `customer_id` view of attribution can
 *     join directly),
 *   - the `context` block is empty (the engine carries no browser
 *     context),
 *   - `properties` is the per-event-name property payload (validated
 *     by the Zod schemas in
 *     `@polaris/shared-schemas/events/attribution/`).
 *
 * The processor stamp is delegated to `@polaris/shared-processor`'s
 * `stampProcessorMetadata` helper so every Polaris processor produces
 * the same dual-shape envelope (nested `processor` block + flat
 * `processor_name` / `processor_version`).
 */

import { stampProcessorMetadata, type ProcessorStamp } from "@polaris/shared-processor";

import { PROCESSOR_IDENTITY, PROCESSOR_NAME, type PROCESSOR_VERSION } from "./transform.js";
import type { CampaignTuple, PrimaryIdentifierKind } from "./transform.js";
import type { AnalyticsEventEnvelope, AttributionEventIdentity } from "./types.js";

/** Names of the three governed attribution events v1 emits. */
export type AttributionEventName =
  | "attribution.touchpoint_captured"
  | "attribution.first_touch_assigned"
  | "attribution.last_touch_assigned";

/**
 * Source identifier stamped on every `attribution.events` envelope
 * emitted by this processor. The `type: "internal"` flag tells
 * downstream consumers (audit, dashboards) that the event was produced
 * by the platform itself, not by a producer SDK.
 */
const ENGINE_SOURCE = Object.freeze({
  type: "internal" as const,
  id: PROCESSOR_NAME,
  sdk: null,
  sdk_version: null,
});

/** Empty canonical context block — attribution events carry no browser context. */
const EMPTY_CONTEXT = Object.freeze({
  ip: null,
  user_agent: null,
  locale: null,
  page: null,
  campaign: null,
});

/**
 * Property payload shapes per event name. Mirror the Zod schemas in
 * `@polaris/shared-schemas/events/attribution/`.
 */
export interface TouchpointCapturedProperties {
  readonly touchpoint_id: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly campaign: CampaignTuple;
  readonly source_event_id: string;
  readonly observed_at: string;
  readonly run_id: string;
}

export interface FirstTouchAssignedProperties {
  readonly touchpoint_id: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly campaign: CampaignTuple;
  readonly source_event_id: string;
  readonly observed_at: string;
  readonly run_id: string;
}

export interface LastTouchAssignedProperties {
  readonly touchpoint_id: string;
  readonly previous_touchpoint_id: string | null;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly campaign: CampaignTuple;
  readonly source_event_id: string;
  readonly observed_at: string;
  readonly run_id: string;
}

export type AttributionEventProperties =
  | TouchpointCapturedProperties
  | FirstTouchAssignedProperties
  | LastTouchAssignedProperties;

/**
 * Output envelope shape. The emit module produces the closed audited
 * shape; callers widen at the publish boundary so this type stays
 * narrow.
 */
export interface AttributionEventEnvelope {
  readonly event_id: string;
  readonly event: AttributionEventName;
  readonly schema_version: 1;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: typeof ENGINE_SOURCE;
  readonly identity: AttributionEventIdentity;
  readonly context: typeof EMPTY_CONTEXT;
  readonly properties: AttributionEventProperties;
  // Dual-shape processor stamp (nested + flat columns) — same shape as
  // analytics-projector / identity-resolver / sessionizer emissions so
  // ClickHouse Kafka Engine ingestion can read both.
  readonly processor: ProcessorStamp;
  readonly processor_name: typeof PROCESSOR_NAME;
  readonly processor_version: typeof PROCESSOR_VERSION;
}

/** Options accepted by `buildTouchpointCapturedEnvelope`. */
export interface BuildTouchpointCapturedOptions {
  readonly raw: AnalyticsEventEnvelope;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: TouchpointCapturedProperties;
}

/** Options accepted by `buildFirstTouchAssignedEnvelope`. */
export interface BuildFirstTouchAssignedOptions {
  readonly raw: AnalyticsEventEnvelope;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: FirstTouchAssignedProperties;
}

/** Options accepted by `buildLastTouchAssignedEnvelope`. */
export interface BuildLastTouchAssignedOptions {
  readonly raw: AnalyticsEventEnvelope;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: LastTouchAssignedProperties;
}

/**
 * Build a canonical `attribution.touchpoint_captured` envelope. Mirrors
 * the source event's `occurred_at` and identity layer.
 */
export function buildTouchpointCapturedEnvelope(
  options: BuildTouchpointCapturedOptions,
): AttributionEventEnvelope {
  return buildEnvelope({
    raw: options.raw,
    eventId: options.eventId,
    eventName: "attribution.touchpoint_captured",
    now: options.now,
    run_id: options.run_id,
    properties: options.properties,
  });
}

/**
 * Build a canonical `attribution.first_touch_assigned` envelope.
 */
export function buildFirstTouchAssignedEnvelope(
  options: BuildFirstTouchAssignedOptions,
): AttributionEventEnvelope {
  return buildEnvelope({
    raw: options.raw,
    eventId: options.eventId,
    eventName: "attribution.first_touch_assigned",
    now: options.now,
    run_id: options.run_id,
    properties: options.properties,
  });
}

/**
 * Build a canonical `attribution.last_touch_assigned` envelope.
 */
export function buildLastTouchAssignedEnvelope(
  options: BuildLastTouchAssignedOptions,
): AttributionEventEnvelope {
  return buildEnvelope({
    raw: options.raw,
    eventId: options.eventId,
    eventName: "attribution.last_touch_assigned",
    now: options.now,
    run_id: options.run_id,
    properties: options.properties,
  });
}

function buildEnvelope(input: {
  readonly raw: AnalyticsEventEnvelope;
  readonly eventId: string;
  readonly eventName: AttributionEventName;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: AttributionEventProperties;
}): AttributionEventEnvelope {
  const ingestedAt = input.now().toISOString();
  // The attribution event identity layer mirrors the source raw identity
  // but is normalised to the closed `AttributionEventIdentity` shape so
  // the emit module owns the on-wire shape regardless of whether the
  // source envelope carried extra forward-compatible fields.
  const identity: AttributionEventIdentity = {
    anonymous_id: input.raw.identity.anonymous_id,
    session_id: input.raw.identity.session_id,
    customer_id: input.raw.identity.customer_id,
    device_id: input.raw.identity.device_id,
  };
  const baseEnvelope = {
    event_id: input.eventId,
    event: input.eventName,
    schema_version: 1 as const,
    project_id: input.raw.project_id,
    environment: input.raw.environment,
    // attribution events mirror the source event's `occurred_at` so the
    // attribution timeline lines up with the analytics timeline at the
    // exact moment the touchpoint was observed.
    occurred_at: input.raw.occurred_at,
    ingested_at: ingestedAt,
    source: ENGINE_SOURCE,
    identity,
    context: EMPTY_CONTEXT,
    properties: input.properties,
  };
  const stamped = stampProcessorMetadata(baseEnvelope, {
    identity: PROCESSOR_IDENTITY,
    now: input.now,
    run_id: input.run_id,
  });
  return stamped as unknown as AttributionEventEnvelope;
}
