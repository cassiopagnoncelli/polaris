/**
 * IPLookup contract and v1 adapters.
 *
 * The geoip-enricher does not couple to a specific IP-to-geo database.
 * The runtime is parameterised by an `IPLookup` interface: any backend
 * that can answer `lookup(ip): GeoResult | null` plugs in. The interface
 * is intentionally small (one method, no setup hooks) so adding a new
 * backend stays a localised change.
 *
 * v1 ships two adapters and a deterministic `NoOpIPLookup`:
 *
 *   - `InMemoryIPLookup` — backed by an in-memory map populated from a
 *     small JSON fixture under `test/fixtures/geoip-sample.json`. Used
 *     by unit tests, the smoke harness, and any integration scenario
 *     that wants deterministic geo results.
 *
 *   - `NoOpIPLookup` — production fail-open default. Returns `null` for
 *     every lookup. The enricher runtime translates a `null` result
 *     into an enriched event with `source = "no_lookup"` and every geo
 *     field set to null. This keeps the streaming pipeline healthy when
 *     the IP-to-geo database is unavailable, which is the fail-open
 *     posture from the architecture (vs failing closed and stalling the
 *     processor's offsets).
 *
 * The MaxMind GeoLite2-backed `MaxmindIPLookup` adapter is out of scope
 * for v1 (the database file is large and license-restricted; it lives
 * outside the repo). A follow-up task adds the adapter behind THIS
 * interface and does not require bumping the processor version.
 */

/**
 * Geo result returned by `IPLookup.lookup(...)`. Every field is
 * optional / nullable so backends that only resolve coarse fields
 * (e.g. country-only databases) can populate what they know without
 * fabricating values for the rest. The runtime translates this into
 * the canonical `enriched.geoip` v1 envelope where every geo field is
 * nullable too.
 *
 * The `source` field is mandatory: the runtime records the backend
 * identity on every emitted event so operators can trace which
 * database snapshot produced a given enrichment without re-running the
 * lookup.
 */
export interface GeoResult {
  /**
   * Identifier of the lookup backend that produced this result.
   * Examples: `"in_memory:test-fixture"`, `"maxmind_geolite2_2026.05"`.
   *
   * Open vocabulary — the catalog schema accepts any lowercase
   * snake/colon-separated identifier.
   */
  readonly source: string;
  /** ISO 3166-1 alpha-2 country code in upper case (e.g. `"US"`). */
  readonly country_code?: string | undefined;
  /** English-language country name (e.g. `"United States"`). */
  readonly country_name?: string | undefined;
  /** ISO 3166-2 subdivision/region code (e.g. `"US-CA"`). */
  readonly region_code?: string | undefined;
  /** English-language region/subdivision name (e.g. `"California"`). */
  readonly region_name?: string | undefined;
  /** City name (e.g. `"Mountain View"`). */
  readonly city?: string | undefined;
  /** Postal/ZIP code (free-form because international codes vary widely). */
  readonly postal_code?: string | undefined;
  /** Coarse city-level latitude in degrees. */
  readonly latitude?: number | undefined;
  /** Coarse city-level longitude in degrees. */
  readonly longitude?: number | undefined;
  /** IANA timezone identifier (e.g. `"America/Los_Angeles"`). */
  readonly timezone?: string | undefined;
  /** Accuracy radius in kilometres reported by the lookup database. */
  readonly accuracy_radius_km?: number | undefined;
}

/**
 * IP lookup contract. Implementations return `null` when the IP is
 * unknown to the backend; the runtime translates that into a null-geo
 * enriched event with `source = "unknown"` (when the backend was wired
 * but the IP didn't match) or `source = "no_lookup"` (NoOp case).
 *
 * The contract is intentionally synchronous because every v1 backend
 * is in-process: a hash map lookup or an mmap read against a local
 * file. If a future backend needs network I/O (commercial GeoIP API)
 * the interface widens to `Promise<GeoResult | null>` and existing
 * adapters return resolved promises.
 */
export interface IPLookup {
  /**
   * Stable identifier of the backend, used as a debugging label. The
   * `GeoResult.source` field on returned results may differ (e.g. when
   * the backend stamps the database version).
   */
  readonly id: string;
  /**
   * Look up the geo result for an IP address. Returns `null` when the
   * IP is syntactically valid but not present in the backend's data.
   * Returns `null` when the IP is invalid; the runtime checks
   * validity before calling `lookup`, so adapters can assume a
   * reasonably well-formed string.
   */
  lookup(ip: string): GeoResult | null;
}

/**
 * Production fail-open default. Returns `null` for every lookup. The
 * runtime translates a `null` result into an enriched event with
 * `source = "no_lookup"` and every geo field set to null. This keeps
 * the streaming pipeline healthy when the IP-to-geo database is not
 * configured — analytics and attribution still receive a row keyed on
 * the source `event_id`.
 *
 * Operators wire `InMemoryIPLookup` (or the future
 * `MaxmindIPLookup`) by passing it to the runtime factory; the NoOp
 * adapter is the default fallback.
 */
export class NoOpIPLookup implements IPLookup {
  readonly id = "no_lookup";

  lookup(_ip: string): GeoResult | null {
    return null;
  }
}

/**
 * In-memory IP lookup backed by a small map. Used by tests, the smoke
 * harness, and integration scenarios that want deterministic geo
 * results without depending on the MaxMind binary database.
 *
 * The map is built once at construction; lookups are O(1). The
 * adapter's `source` field on every returned result is whatever the
 * caller pre-stamped on the entry — typically `"in_memory:<label>"`
 * so operators can tell test-fixture data apart from production
 * results during lineage queries.
 */
export class InMemoryIPLookup implements IPLookup {
  readonly id: string;
  private readonly entries: ReadonlyMap<string, GeoResult>;

  /**
   * @param entries  Map of IP → geo result, an array of `[ip, result]`
   *                 tuples, or a plain `Record<string, GeoResult>`
   *                 (e.g. the parsed JSON fixture). Keys are the IP
   *                 address as stored in the source event (normalised
   *                 by the caller); the adapter does not normalise IPs
   *                 itself because the test fixtures pre-stamp the
   *                 exact strings the runtime will see.
   * @param options.id  Optional adapter identifier surfaced in log
   *                    lines. Defaults to `"in_memory"`.
   */
  constructor(
    entries:
      | ReadonlyMap<string, GeoResult>
      | ReadonlyArray<[string, GeoResult]>
      | Readonly<Record<string, GeoResult>>,
    options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "in_memory";
    this.entries = toMap(entries);
  }

  lookup(ip: string): GeoResult | null {
    const match = this.entries.get(ip);
    return match ?? null;
  }
}

function toMap(
  source:
    | ReadonlyMap<string, GeoResult>
    | ReadonlyArray<[string, GeoResult]>
    | Readonly<Record<string, GeoResult>>,
): ReadonlyMap<string, GeoResult> {
  if (source instanceof Map) return source;
  if (Array.isArray(source)) return new Map(source);
  // Plain object literal (parsed JSON fixture, etc.).
  return new Map(Object.entries(source as Record<string, GeoResult>));
}

/**
 * Convenience: build an `InMemoryIPLookup` from a plain object literal.
 * Fixture JSON files load straight into the right shape.
 *
 * @example
 * ```ts
 * import sample from "../test/fixtures/geoip-sample.json";
 * const lookup = fromFixture(sample);
 * ```
 */
export function fromFixture(
  fixture: Readonly<Record<string, GeoResult>>,
  options: { readonly id?: string } = {},
): InMemoryIPLookup {
  const entries = new Map<string, GeoResult>();
  for (const [ip, result] of Object.entries(fixture)) {
    entries.set(ip, result);
  }
  return new InMemoryIPLookup(entries, options);
}
