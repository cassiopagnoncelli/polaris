import { z } from "zod";

/**
 * `enriched.geoip` v1 — DEPRECATED, sunset 2026-08-18.
 *
 * Was emitted by `sync/legacy/geoip-enricher/v1/` once per source
 * `raw.events` record. The enricher read `envelope.context.ip` from the
 * source event, looked the address up in a local IP-to-geo database, and
 * republished the geo result on `enriched.events` keyed back to the source
 * `event_id`. Downstream consumers (analytics, attribution) joined on
 * `event_id` rather than mutating the immutable source envelope.
 *
 * `f9ae3d0` removed the producer and the `enriched.events` family together,
 * so nothing can publish this event. The schema stays because the catalog
 * entry stays: a replay of archived `enriched.events` NDJSON validates the
 * bytes it reads back against this shape, and deleting it would make those
 * events unreadable rather than merely un-producible. See
 * `catalog/events/enriched/geoip.v1.yaml`.
 *
 * The capability moved rather than ended — `sync/enrichment/geoip/v1/`
 * writes the same lookup onto the event's own `enrichment` block on
 * `resolved.events`. The successor is a field, not an event, which is why
 * there is no v2 here.
 *
 * Design notes:
 *
 *   - The IP itself never appears on the enriched event. Per
 *     `docs/architecture/01-event-contract.md` § "Forbidden-Field Policy",
 *     IP is sensitive metadata; the enricher persists only `source_ip_hash`
 *     (SHA-256 of the source IP) so downstream lineage can verify which
 *     observation produced the geo result without re-exposing the raw IP.
 *
 *   - Every geo field is nullable: lookups commonly fail to populate
 *     postal codes, region names, etc. The shape stays additive on a
 *     nullable basis so v1 covers both partial and complete results
 *     without requiring a `v2` for every missing field.
 *
 *   - `source` records the IP-lookup backend that produced the result
 *     (e.g. `"in_memory:test-fixture"`, `"maxmind_geolite2_<version>"`).
 *     This is observability data, not semantic — it lets operators trace
 *     which database snapshot generated a particular enrichment without
 *     bumping the schema version when the backend changes.
 *
 *   - `source_event_id` is the `event_id` of the canonical raw event the
 *     enrichment was derived from. Downstream consumers join on this.
 *
 *   - v1 of the resolver only emits results for IPv4 / IPv6 syntactically
 *     valid addresses. When the source event carries no IP (or carries an
 *     unparseable value), the enricher emits a row with `country_code`
 *     etc. all null and `source = "no_ip"` so downstream queries can still
 *     observe the event was processed. This is the same fail-open posture
 *     the runtime takes when the IP lookup database is unavailable.
 */

/**
 * Lookup-backend identifier. Open vocabulary so swapping the backend
 * (in-memory test fixture → MaxMind GeoLite2 → MaxMind GeoIP2 commercial
 * → IP2Location) doesn't require a schema bump. Reasonable shapes:
 *
 *   - `"in_memory:<label>"`       — test fixture or smoke harness
 *   - `"no_ip"`                   — source event carried no IP
 *   - `"no_lookup"`               — IP present but no database wired
 *   - `"unknown"`                 — database wired, no match
 *   - `"maxmind_geolite2_<ver>"`  — MaxMind GeoLite2 (future backend)
 *   - `"ip2location_<ver>"`       — IP2Location (future backend)
 */
export const geoipSourceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_:.+-]*$/u, {
    message: "source must be lowercase snake/colon-separated",
  });

/**
 * Two-letter ISO 3166-1 alpha-2 country code in upper case. Mirrors the
 * shape `iso_country_code` carries elsewhere in the catalog (currency,
 * marketplaces). Null when the lookup did not resolve a country.
 */
export const geoipCountryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/u, {
    message: "country_code must be ISO 3166-1 alpha-2 in upper case",
  });

/**
 * ISO 3166-2 region/subdivision code. Free-form (e.g. `US-CA`, `BR-SP`,
 * `GB-LND`). The MaxMind dataset returns this format; smaller fixtures
 * may use just the subdivision portion (`CA`). Null when not resolved.
 */
export const geoipRegionCodeSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z0-9-]+$/u, {
    message: "region_code must be ISO 3166-2 (alphanumeric + hyphen)",
  });

/** SHA-256 hex of the source IP. Lowercase, exactly 64 hex chars. */
export const geoipSourceIpHashSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u, {
    message: "source_ip_hash must be lowercase hex SHA-256",
  });

export const enrichedGeoipV1PropertiesSchema = z
  .object({
    /**
     * Canonical event_id of the source raw event this enrichment was
     * derived from. Downstream consumers (analytics, attribution) join
     * the enrichment back to the source event on this field.
     */
    source_event_id: z.string().min(1).max(128),
    /**
     * Lowercase hex SHA-256 of the source IP. Present when the source
     * event carried an IP; null when no IP was supplied. The raw IP
     * itself is never persisted on the enriched event.
     */
    source_ip_hash: geoipSourceIpHashSchema.nullable(),
    /**
     * Identifier of the lookup backend that produced this result. See
     * `geoipSourceSchema` for vocabulary. Always present.
     */
    source: geoipSourceSchema,
    /** ISO 3166-1 alpha-2 country code. Null when not resolved. */
    country_code: geoipCountryCodeSchema.nullable(),
    /** English-language country name. Null when not resolved. */
    country_name: z.string().min(1).max(128).nullable(),
    /** ISO 3166-2 subdivision/region code. Null when not resolved. */
    region_code: geoipRegionCodeSchema.nullable(),
    /** English-language region/subdivision name. Null when not resolved. */
    region_name: z.string().min(1).max(128).nullable(),
    /** City name. Null when not resolved. */
    city: z.string().min(1).max(128).nullable(),
    /** Postal/ZIP code. Free-form because international codes vary widely. */
    postal_code: z.string().min(1).max(32).nullable(),
    /** Coarse city-level latitude in degrees. Null when not resolved. */
    latitude: z.number().min(-90).max(90).nullable(),
    /** Coarse city-level longitude in degrees. Null when not resolved. */
    longitude: z.number().min(-180).max(180).nullable(),
    /** IANA timezone identifier (e.g. `America/Los_Angeles`). */
    timezone: z.string().min(1).max(64).nullable(),
    /**
     * Accuracy radius in kilometres reported by the lookup database. Some
     * backends (MaxMind) expose this; in-memory fixtures usually omit it.
     */
    accuracy_radius_km: z.number().int().min(0).max(50_000).nullable(),
    /**
     * Run id that recorded the enrichment. Mirrors the
     * `processor_runs.run_id` value the enricher is currently registered
     * under.
     */
    run_id: z.string().min(1).max(64),
  })
  .strict();

export type EnrichedGeoipV1Properties = z.infer<typeof enrichedGeoipV1PropertiesSchema>;
