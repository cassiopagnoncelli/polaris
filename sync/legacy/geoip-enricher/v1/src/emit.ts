/**
 * Canonical `enriched.events` envelope builder for geoip-enricher v1.
 *
 * The runtime drives the enricher and decides what to emit. This module
 * turns that decision into a canonical platform envelope ready for
 * `PolarisProducer.publishEvent`.
 *
 * Envelope rules (per `docs/architecture/01-event-contract.md`):
 *
 *   - top-level shape is the canonical envelope,
 *   - `project_id` and `environment` are inherited from the source raw
 *     event (the enrichment is scoped to the same project/environment
 *     as the observation),
 *   - `occurred_at` mirrors the source event's `occurred_at` so the
 *     enrichment lands on the same timeline as the observation that
 *     triggered it,
 *   - `ingested_at` is stamped at emission time by the enricher (the
 *     event was technically "ingested" by the enricher),
 *   - the `source` block carries the enricher's own identity:
 *     `{ type: "internal", id: "geoip-enricher" }` so downstream
 *     consumers can tell the event came from the platform, not a
 *     producer,
 *   - the `identity` block carries the same identifiers the source
 *     event carried — never invented ones,
 *   - the `context` block is EMPTY (`ip: null`, `user_agent: null`, ...).
 *     Keeping `ip` out of the enriched envelope is the whole point of
 *     the PII posture: raw IP is in the SOURCE event only,
 *   - `properties` is the canonical `enriched.geoip` v1 payload.
 *
 * The processor stamp is delegated to
 * `@polaris/shared-processor`'s `stampProcessorMetadata` helper so every
 * Polaris processor produces the same dual-shape envelope (nested
 * `processor` block + flat `processor_name` / `processor_version`).
 */

import { type ProcessorStamp, stampProcessorMetadata } from "@polaris/shared-processor";
import type { EnrichedGeoipV1Properties } from "@polaris/shared-schemas";

import { PROCESSOR_IDENTITY, PROCESSOR_NAME, type PROCESSOR_VERSION } from "./transform.js";
import type { RawEventEnvelope, RawEventIdentity } from "./types.js";

/** Event name emitted by v1. */
export type GeoipEventName = "enriched.geoip";

/**
 * Source identifier stamped on every `enriched.events` envelope
 * emitted by this processor. The `type: "internal"` flag tells
 * downstream consumers (audit, dashboards) that the event was
 * produced by the platform itself, not by a producer SDK.
 */
const ENRICHER_SOURCE = Object.freeze({
  type: "internal" as const,
  id: PROCESSOR_NAME,
  sdk: null,
  sdk_version: null,
});

/**
 * Empty canonical context block — the enricher does NOT carry the
 * source IP forward onto its emitted event. The raw IP lives only on
 * the canonical `raw.events` record; the enriched event carries the
 * SHA-256 hash on `properties.source_ip_hash`.
 */
const EMPTY_CONTEXT = Object.freeze({
  ip: null,
  user_agent: null,
  locale: null,
  page: null,
  campaign: null,
});

/**
 * Output envelope shape. The emit module produces the closed audited
 * shape; the producer widens at the publish boundary so this type
 * stays narrow.
 */
export interface GeoipEnvelope {
  readonly event_id: string;
  readonly event: GeoipEventName;
  readonly schema_version: 1;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: typeof ENRICHER_SOURCE;
  readonly identity: RawEventIdentity;
  readonly context: typeof EMPTY_CONTEXT;
  readonly properties: EnrichedGeoipV1Properties;
  // Dual-shape processor stamp (nested + flat columns) — same shape as
  // analytics-projector's and identity-resolver's emission so ClickHouse
  // Kafka Engine ingestion can read both.
  readonly processor: ProcessorStamp;
  readonly processor_name: typeof PROCESSOR_NAME;
  readonly processor_version: typeof PROCESSOR_VERSION;
}

/** Options accepted by `buildGeoipEnvelope`. */
export interface BuildGeoipEnvelopeOptions {
  readonly raw: RawEventEnvelope;
  readonly properties: EnrichedGeoipV1Properties;
  readonly eventId: string;
  readonly now: () => Date;
  readonly run_id?: string | undefined;
}

/**
 * Build the canonical envelope for an `enriched.geoip` event.
 *
 * The function is pure (no I/O). `now` controls `ingested_at` and the
 * processor stamp's `ran_at`. The caller passes a deterministic clock
 * in golden-fixture tests.
 */
export function buildGeoipEnvelope(options: BuildGeoipEnvelopeOptions): GeoipEnvelope {
  const { raw, properties, eventId, now } = options;
  const ingestedAt = now().toISOString();

  const baseEnvelope = {
    event_id: eventId,
    event: "enriched.geoip" as const,
    schema_version: 1 as const,
    project_id: raw.project_id,
    environment: raw.environment,
    occurred_at: raw.occurred_at,
    ingested_at: ingestedAt,
    source: ENRICHER_SOURCE,
    identity: raw.identity,
    context: EMPTY_CONTEXT,
    properties,
  };

  const stamped = stampProcessorMetadata(baseEnvelope, {
    identity: PROCESSOR_IDENTITY,
    now,
    ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
  });

  return stamped as unknown as GeoipEnvelope;
}
