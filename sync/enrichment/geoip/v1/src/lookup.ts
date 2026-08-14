/**
 * IP lookup port and the adapters that are not MaxMind.
 *
 * Migrated from `sync/legacy/geoip-enricher/v1/src/lookup.ts`, whose
 * module header promised exactly this: "The MaxMind GeoLite2-backed
 * `MaxmindIPLookup` adapter is out of scope for v1 ... A follow-up task
 * adds the adapter behind THIS interface." That follow-up is this unit;
 * the port is unchanged, so the promise cost nothing to keep.
 *
 * The contract stays SYNCHRONOUS. Every backend here is in-process — a
 * hash-map get or an mmap read against a local file — and the enrichment
 * runtime is on the hot path of the spine. If a network-backed geo
 * service ever lands, the interface widens to a Promise and these
 * adapters return resolved ones; nothing about that decision is easier
 * to make today by pre-emptively making it async.
 */

/**
 * What a backend can know about an address.
 *
 * Every geo field is optional so a coarse database (country-only) can
 * populate what it has without inventing the rest. `source` is mandatory
 * and version-tagged where the backend can manage it, because "which
 * database snapshot produced this row" is the question an operator asks
 * when a geo value looks wrong.
 */
export interface GeoResult {
  /** Backend identity, e.g. `maxmind:GeoLite2-City:2026-08-01`. */
  readonly source: string;
  /** ISO 3166-1 alpha-2, upper case (`"US"`). */
  readonly country_code?: string | undefined;
  /** ISO 3166-2 subdivision code (`"CA"`), else the subdivision name. */
  readonly region_code?: string | undefined;
  /** English subdivision name (`"California"`). */
  readonly region_name?: string | undefined;
  /** English city name (`"Mountain View"`). */
  readonly city?: string | undefined;
}

/**
 * The port. `lookup` returns `null` when the address is syntactically
 * valid but the backend has nothing for it; the caller distinguishes
 * that from "no backend wired" by reading `id`.
 */
export interface IPLookup {
  /** Stable backend identifier, surfaced on a miss and in logs. */
  readonly id: string;
  /** Resolve an address the caller has already validated. */
  lookup(ip: string): GeoResult | null;
}

/** `source` when the event carried no usable address. */
export const SOURCE_NO_IP = "no_ip" as const;
/** `source` when no backend is wired — the fail-open default. */
export const SOURCE_NO_LOOKUP = "no_lookup" as const;

/**
 * Fail-open default: resolves nothing, ever.
 *
 * The stage must keep moving when the geo database is missing or
 * unreadable. Geo is decoration on the spine event; stalling the spine —
 * and with it every destination — because a city name is unavailable
 * would be the wrong trade by a wide margin. A `geo` block with
 * `source: "no_lookup"` says plainly that nothing was consulted, which
 * an operator can alert on.
 */
export class NoOpIPLookup implements IPLookup {
  public readonly id = SOURCE_NO_LOOKUP;

  public lookup(_ip: string): GeoResult | null {
    return null;
  }
}

/**
 * Map-backed lookup for tests, fixtures and the smoke harness.
 *
 * Keys are matched exactly, with no normalisation, because `parseIp`
 * hands through the address in the form the event carried it — the
 * fixtures store that same literal.
 */
export class InMemoryIPLookup implements IPLookup {
  public readonly id: string;
  private readonly entries: ReadonlyMap<string, GeoResult>;

  public constructor(
    entries: ReadonlyMap<string, GeoResult> | Readonly<Record<string, GeoResult>>,
    options: { readonly id?: string } = {},
  ) {
    this.id = options.id ?? "in_memory";
    this.entries =
      entries instanceof Map
        ? entries
        : new Map(Object.entries(entries as Record<string, GeoResult>));
  }

  public lookup(ip: string): GeoResult | null {
    return this.entries.get(ip) ?? null;
  }
}
