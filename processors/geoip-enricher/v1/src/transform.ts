/**
 * Pure transform: raw event → geoip-enricher decision.
 *
 * The enricher's hot path is:
 *
 *   1. Read `envelope.context.ip` from the canonical raw event.
 *   2. Structurally validate the IP (Node's `isIP`).
 *   3. Hash the IP with SHA-256 for `source_ip_hash` / debug log lines.
 *   4. Call `IPLookup.lookup(...)` for a `GeoResult | null`.
 *   5. Translate the result into an `EnrichmentDecision` the runtime
 *      turns into the canonical `enriched.geoip` envelope.
 *
 * The decision is pure: no I/O, no clock reads beyond the caller-
 * supplied `now()`. Replay tooling (P7-003) and unit tests can drive
 * the same function offline.
 *
 * Three terminal `source` values fall out of the decision:
 *
 *   - `"no_ip"`     — the source event carried no IP (or an unparseable
 *                     value). Every geo field is null; `source_ip_hash`
 *                     is null.
 *   - `"no_lookup"` — the IPLookup adapter returned null (production
 *                     fail-open NoOp, or the IP was valid but absent
 *                     from a wired backend with `id = "no_lookup"`).
 *                     Every geo field is null; `source_ip_hash` is the
 *                     hash of the valid IP.
 *   - `"<backend>"` — the IPLookup adapter returned a GeoResult. Every
 *                     geo field is populated from the result;
 *                     `source_ip_hash` is the hash of the valid IP;
 *                     `source` is the result's own backend identifier.
 *
 * v1 emits a row for EVERY input event (even when no IP is present)
 * so downstream consumers can rely on a 1:1 mapping between source
 * `raw.events` records and `enriched.geoip` records.
 */

import type { EnrichedGeoipV1Properties } from "@polaris/shared-schemas";

import { hashIp, parseIp } from "./ip.js";
import type { GeoResult, IPLookup } from "./lookup.js";

/**
 * Static processor identity for v1. Held as a frozen literal so callers
 * cannot mutate it. Exported here so the runtime, bootstrap, tests, and
 * DLQ helpers reference the same constants.
 */
export const PROCESSOR_NAME = "geoip-enricher" as const;
export const PROCESSOR_VERSION = "v1" as const;

export const PROCESSOR_IDENTITY = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
}) as { readonly name: typeof PROCESSOR_NAME; readonly version: typeof PROCESSOR_VERSION };

/**
 * Terminal `source` literals the runtime emits when no real lookup
 * happened. The catalog schema (`geoipSourceSchema`) intentionally
 * accepts an open vocabulary, so these are not exhaustive — production
 * backends stamp their own version-tagged identifiers (e.g.
 * `"maxmind_geolite2_2026.05"`).
 */
export const SOURCE_NO_IP = "no_ip" as const;
export const SOURCE_NO_LOOKUP = "no_lookup" as const;

/**
 * Decision returned by the pure transform. The runtime turns this into
 * the canonical envelope; the decision itself is the smallest piece of
 * data needed to build the `enriched.geoip` properties payload.
 */
export interface EnrichmentDecision {
  /** Lookup-backend identifier stamped on the emitted event. */
  readonly source: string;
  /** Lowercase hex SHA-256 of the source IP. `null` when no IP. */
  readonly source_ip_hash: string | null;
  /** Country code (`"US"`), or `null` when not resolved. */
  readonly country_code: string | null;
  /** Country name (`"United States"`), or `null` when not resolved. */
  readonly country_name: string | null;
  /** Region code (`"US-CA"`), or `null` when not resolved. */
  readonly region_code: string | null;
  /** Region name (`"California"`), or `null` when not resolved. */
  readonly region_name: string | null;
  /** City name (`"Mountain View"`), or `null` when not resolved. */
  readonly city: string | null;
  /** Postal/ZIP code, or `null` when not resolved. */
  readonly postal_code: string | null;
  /** Coarse city-level latitude, or `null` when not resolved. */
  readonly latitude: number | null;
  /** Coarse city-level longitude, or `null` when not resolved. */
  readonly longitude: number | null;
  /** IANA timezone, or `null` when not resolved. */
  readonly timezone: string | null;
  /** Accuracy radius in km, or `null` when not reported. */
  readonly accuracy_radius_km: number | null;
}

/**
 * Build the enrichment decision from the raw event's `context.ip`. The
 * function does NOT inspect any other envelope field — `source_event_id`,
 * `project_id`, etc. are wired by the runtime when assembling the
 * envelope.
 */
export function decideEnrichment(input: {
  readonly ip: unknown;
  readonly lookup: IPLookup;
}): EnrichmentDecision {
  const parsed = parseIp(input.ip);
  if (parsed === null) {
    return emptyDecision({ source: SOURCE_NO_IP, source_ip_hash: null });
  }

  const ipHash = hashIp(parsed);
  const result = input.lookup.lookup(parsed);
  if (result === null) {
    // Backend returned null. Use the backend's own id (e.g. "no_lookup"
    // for the NoOp adapter, "unknown" for a wired backend that missed)
    // so operators can tell production fail-open apart from a
    // database-backed miss.
    return emptyDecision({
      source: input.lookup.id === SOURCE_NO_LOOKUP ? SOURCE_NO_LOOKUP : input.lookup.id,
      source_ip_hash: ipHash,
    });
  }

  return decisionFromGeoResult(result, ipHash);
}

/**
 * Build the canonical `enriched.geoip` properties payload from a
 * decision. The runtime stamps `source_event_id` and `run_id` on top.
 */
export function decisionToProperties(
  decision: EnrichmentDecision,
  context: { readonly source_event_id: string; readonly run_id: string },
): EnrichedGeoipV1Properties {
  return {
    source_event_id: context.source_event_id,
    source_ip_hash: decision.source_ip_hash,
    source: decision.source,
    country_code: decision.country_code,
    country_name: decision.country_name,
    region_code: decision.region_code,
    region_name: decision.region_name,
    city: decision.city,
    postal_code: decision.postal_code,
    latitude: decision.latitude,
    longitude: decision.longitude,
    timezone: decision.timezone,
    accuracy_radius_km: decision.accuracy_radius_km,
    run_id: context.run_id,
  };
}

function emptyDecision(input: {
  readonly source: string;
  readonly source_ip_hash: string | null;
}): EnrichmentDecision {
  return {
    source: input.source,
    source_ip_hash: input.source_ip_hash,
    country_code: null,
    country_name: null,
    region_code: null,
    region_name: null,
    city: null,
    postal_code: null,
    latitude: null,
    longitude: null,
    timezone: null,
    accuracy_radius_km: null,
  };
}

function decisionFromGeoResult(result: GeoResult, ipHash: string): EnrichmentDecision {
  return {
    source: result.source,
    source_ip_hash: ipHash,
    country_code: result.country_code ?? null,
    country_name: result.country_name ?? null,
    region_code: result.region_code ?? null,
    region_name: result.region_name ?? null,
    city: result.city ?? null,
    postal_code: result.postal_code ?? null,
    latitude: result.latitude ?? null,
    longitude: result.longitude ?? null,
    timezone: result.timezone ?? null,
    accuracy_radius_km: result.accuracy_radius_km ?? null,
  };
}
