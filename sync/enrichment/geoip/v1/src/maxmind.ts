/**
 * MaxMind mmdb-backed IP lookup.
 *
 * The adapter the legacy processor left as a TODO. It reads a GeoLite2
 * (or GeoIP2) City database with `mmdb-lib` — pure JavaScript, no native
 * build step, no network — and answers from an in-memory buffer.
 *
 * ## The database is not in the repository
 *
 * MaxMind's license forbids redistributing the mmdb file, and it is
 * ~60 MB regardless. It is an operational artifact: fetched by
 * `infra/geoip/refresh-geoip.sh` from cron, mounted into the container,
 * and pointed at by `POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH`. That is why
 * an ABSENT database is a normal, non-fatal state rather than a boot
 * failure — see `openMaxmindLookup`.
 *
 * ## Loaded once, held in memory
 *
 * The file is read fully at construction and kept as a Buffer. Node's
 * `readFileSync` plus mmdb-lib's tree walk is a memory-resident lookup:
 * ~60 MB of RSS per process, sub-microsecond per query, no I/O on the
 * hot path. A refresh lands a NEW file; the running process keeps the
 * snapshot it started with until it is restarted, which is what makes
 * `source` (stamped with the build epoch) an honest answer to "which
 * database produced this row" for the life of the process.
 */

import { readFileSync } from "node:fs";
import { Reader } from "mmdb-lib";
import type { CityResponse } from "mmdb-lib";

import type { GeoResult, IPLookup } from "./lookup.js";

/**
 * A loaded MaxMind database.
 *
 * `id` carries the database type and its build date — e.g.
 * `maxmind:GeoLite2-City:2026-08-01` — so a geo value that looks wrong
 * can be traced to the snapshot that produced it without re-running the
 * lookup. Both halves matter: the type distinguishes City from Country
 * (different fields resolve), the date distinguishes refreshes.
 */
export class MaxmindIPLookup implements IPLookup {
  public readonly id: string;
  private readonly reader: Reader<CityResponse>;

  public constructor(database: Buffer, options: { readonly id?: string } = {}) {
    this.reader = new Reader<CityResponse>(database);
    this.id = options.id ?? buildSourceId(this.reader);
  }

  public lookup(ip: string): GeoResult | null {
    // mmdb-lib throws on a malformed address rather than returning null.
    // The caller validates with `parseIp` first, so a throw here means
    // the database itself is corrupt — which must not take the stage
    // down over one event.
    let found: CityResponse | null;
    try {
      found = this.reader.get(ip);
    } catch {
      return null;
    }
    if (found === null) return null;
    return mapCityResponse(found, this.id);
  }
}

/**
 * Translate one MaxMind City record into a `GeoResult`.
 *
 * Exported and pure because this — not the tree walk — is the part with
 * decisions in it, and a 60 MB license-restricted binary is the wrong
 * thing to need in order to test them. `MaxmindIPLookup.lookup` is the
 * thin wrapper that reads a record and calls this.
 */
export function mapCityResponse(record: CityResponse, source: string): GeoResult | null {
  const subdivision = record.subdivisions?.[0];
  // `registered_country` is the fallback for addresses MaxMind places by
  // registration rather than by observed location — satellite and some
  // mobile ranges — where it is the only country the record carries.
  const country = record.country?.iso_code ?? record.registered_country?.iso_code;

  const result: GeoResult = {
    source,
    ...(country !== undefined ? { country_code: country } : {}),
    // The ISO subdivision code is the stabler key, so it wins; the
    // English name is the fallback for countries whose subdivisions
    // carry no code. `region_name` keeps the human-readable form
    // alongside it either way.
    ...(subdivision?.iso_code !== undefined ? { region_code: subdivision.iso_code } : {}),
    ...(subdivision?.names.en !== undefined ? { region_name: subdivision.names.en } : {}),
    ...(record.city?.names.en !== undefined ? { city: record.city.names.en } : {}),
  };

  // A record with no usable field is a MISS, not a hit with four nulls:
  // the address resolved to a network the database knows but has
  // nothing locational to say about. Reporting it as a hit would claim
  // the database answered when it did not.
  if (
    result.country_code === undefined &&
    result.region_code === undefined &&
    result.region_name === undefined &&
    result.city === undefined
  ) {
    return null;
  }
  return result;
}

function buildSourceId(reader: Reader<CityResponse>): string {
  const { databaseType, buildEpoch } = reader.metadata;
  const day = buildEpoch instanceof Date ? buildEpoch.toISOString().slice(0, 10) : "unknown";
  return `maxmind:${databaseType}:${day}`;
}

/** Outcome of trying to open a database at a configured path. */
export type OpenMaxmindOutcome =
  | { readonly kind: "opened"; readonly lookup: MaxmindIPLookup }
  | { readonly kind: "absent"; readonly reason: string };

/**
 * Open the database at `path`, or explain why not.
 *
 * Never throws. A missing or unreadable database is reported as
 * `absent`, and the caller falls back to `NoOpIPLookup` — the stage runs
 * with `geo.source = "no_lookup"` rather than refusing to start. That is
 * the same fail-open posture the legacy processor shipped, and the
 * reason is unchanged: geo is decoration on the spine event, and every
 * destination downstream would stall behind a missing city name.
 *
 * The failure is loud in the one place that matters — the caller logs
 * `reason` at warn on boot, and every emitted event says `no_lookup` —
 * so "we silently lost geo" is not a state anyone has to guess at.
 */
export function openMaxmindLookup(path: string): OpenMaxmindOutcome {
  let database: Buffer;
  try {
    database = readFileSync(path);
  } catch (err) {
    return { kind: "absent", reason: describe(err) };
  }
  try {
    return { kind: "opened", lookup: new MaxmindIPLookup(database) };
  } catch (err) {
    // Present but not a valid mmdb — a truncated download, an HTML error
    // page saved under the .mmdb name, a half-written refresh.
    return { kind: "absent", reason: `not a readable mmdb database: ${describe(err)}` };
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
