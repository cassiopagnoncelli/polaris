/**
 * Canonical `session.events` envelope builder for sessionizer v1.
 *
 * The runtime drives the sessionizer and decides which session events
 * to emit. This module turns those decisions into canonical platform
 * envelopes ready for the producer.
 *
 * Envelope rules (per `docs/architecture/01-event-contract.md`):
 *
 *   - top-level shape is the canonical envelope,
 *   - `project_id` and `environment` are inherited from the source raw
 *     event (the session event is scoped to the same project/environment
 *     as the observation),
 *   - `occurred_at` mirrors the relevant boundary timestamp:
 *       * `session.started.occurred_at` = the session's `started_at`
 *         (the moment the window opened),
 *       * `session.ended.occurred_at`   = the session's `ended_at`
 *         (last_seen_at + inactivity_seconds — the WINDOW BOUNDARY,
 *         not the moment of detection),
 *   - `ingested_at` is stamped at emission time by the sessionizer (the
 *     event was technically "ingested" by the processor),
 *   - the `source` block carries the processor's own identity:
 *     `{ type: "internal", id: "sessionizer" }` so downstream consumers
 *     can tell the event came from the platform, not a producer,
 *   - the `identity` block mirrors the source event's identity layer
 *     (so analytics keeping a `customer_id` view of sessions can join
 *     directly),
 *   - the `context` block is empty (the sessionizer does not see
 *     browser context),
 *   - `properties` is the per-event-name property payload (validated by
 *     the Zod schemas in `@polaris/spec/events/session/`).
 *
 * The processor stamp is delegated to `@polaris/pipeline`'s
 * `stampProcessorMetadata` helper so every Polaris processor produces
 * the same dual-shape envelope (nested `processor` block + flat
 * `processor_name` / `processor_version`).
 */

import { type ProcessorStamp, stampProcessorMetadata } from "@polaris/pipeline";
import type { PrimaryIdentifierKind } from "./transform.js";
import { PROCESSOR_IDENTITY, PROCESSOR_NAME, type PROCESSOR_VERSION } from "./transform.js";
import type { RawEventEnvelope, RawEventIdentity } from "./types.js";

/** Names of the two governed session events v1 emits. */
export type SessionEventName = "session.started" | "session.ended";

/**
 * Source identifier stamped on every `session.events` envelope emitted
 * by this processor. The `type: "internal"` flag tells downstream
 * consumers (audit, dashboards) that the event was produced by the
 * platform itself, not by a producer SDK.
 */
const SESSIONIZER_SOURCE = Object.freeze({
  type: "internal" as const,
  id: PROCESSOR_NAME,
  sdk: null,
  sdk_version: null,
});

/** Empty canonical context block — the sessionizer has no browser context. */
const EMPTY_CONTEXT = Object.freeze({
  ip: null,
  user_agent: null,
  locale: null,
  page: null,
  campaign: null,
});

/**
 * Property payload shapes per event name. Mirror the Zod schemas in
 * `@polaris/spec/events/session/`.
 */
export interface SessionStartedProperties {
  readonly session_id: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly started_at: string;
  readonly source_event_id: string;
  readonly run_id: string;
}

export interface SessionEndedProperties {
  readonly session_id: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly last_seen_at: string;
  readonly inactivity_seconds: number;
  readonly event_count: number;
  readonly run_id: string;
}

export type SessionEventProperties = SessionStartedProperties | SessionEndedProperties;

/**
 * Output envelope shape. The emit module produces the closed audited
 * shape; callers widen at the publish boundary so this type stays
 * narrow.
 */
export interface SessionEventEnvelope {
  readonly event_id: string;
  readonly event: SessionEventName;
  readonly schema_version: 1;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: typeof SESSIONIZER_SOURCE;
  readonly identity: RawEventIdentity;
  readonly context: typeof EMPTY_CONTEXT;
  readonly properties: SessionEventProperties;
  // Dual-shape processor stamp (nested + flat columns) — same shape as
  // analytics-projector / identity-resolver emissions so ClickHouse
  // Kafka Engine ingestion can read both.
  readonly processor: ProcessorStamp;
  readonly processor_name: typeof PROCESSOR_NAME;
  readonly processor_version: typeof PROCESSOR_VERSION;
}

/** Options accepted by `buildSessionStartedEnvelope`. */
export interface BuildSessionStartedOptions {
  readonly raw: RawEventEnvelope;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: SessionStartedProperties;
}

/** Options accepted by `buildSessionEndedEnvelope`. */
export interface BuildSessionEndedOptions {
  readonly raw: RawEventEnvelope;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: SessionEndedProperties;
}

/**
 * Build a canonical `session.started` envelope. The event's
 * `occurred_at` is anchored to the session's `started_at` (i.e. the
 * source event's `occurred_at`), so downstream timelines see the
 * session start on the producer's clock, not the processor's.
 */
export function buildSessionStartedEnvelope(
  options: BuildSessionStartedOptions,
): SessionEventEnvelope {
  return buildEnvelope({
    raw: options.raw,
    eventId: options.eventId,
    eventName: "session.started",
    occurredAt: options.properties.started_at,
    now: options.now,
    run_id: options.run_id,
    properties: options.properties,
  });
}

/**
 * Build a canonical `session.ended` envelope. The event's `occurred_at`
 * is anchored to the WINDOW BOUNDARY (last_seen_at + inactivity_seconds),
 * not the moment of detection. This keeps the downstream timeline stable
 * across replays.
 */
export function buildSessionEndedEnvelope(options: BuildSessionEndedOptions): SessionEventEnvelope {
  return buildEnvelope({
    raw: options.raw,
    eventId: options.eventId,
    eventName: "session.ended",
    occurredAt: options.properties.ended_at,
    now: options.now,
    run_id: options.run_id,
    properties: options.properties,
  });
}

function buildEnvelope(input: {
  readonly raw: RawEventEnvelope;
  readonly eventId: string;
  readonly eventName: SessionEventName;
  readonly occurredAt: string;
  readonly now: () => Date;
  readonly run_id: string;
  readonly properties: SessionEventProperties;
}): SessionEventEnvelope {
  const ingestedAt = input.now().toISOString();
  const baseEnvelope = {
    event_id: input.eventId,
    event: input.eventName,
    schema_version: 1 as const,
    project_id: input.raw.project_id,
    environment: input.raw.environment,
    occurred_at: input.occurredAt,
    ingested_at: ingestedAt,
    source: SESSIONIZER_SOURCE,
    identity: input.raw.identity,
    context: EMPTY_CONTEXT,
    properties: input.properties,
  };
  const stamped = stampProcessorMetadata(baseEnvelope, {
    identity: PROCESSOR_IDENTITY,
    now: input.now,
    run_id: input.run_id,
  });
  return stamped as unknown as SessionEventEnvelope;
}
