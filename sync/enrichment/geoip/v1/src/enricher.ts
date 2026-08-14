/**
 * The geo enricher: `context.ip` → the envelope's `enrichment.geo` block.
 *
 * Pure, given a lookup backend. No clock, no I/O of its own, no
 * knowledge of the transport — the runtime hands it an address and gets
 * back a block, which is what lets the whole decision table below be
 * tested without a broker or a database.
 *
 * ## Why the output is narrower than the backend's answer
 *
 * `geoEnrichmentSchema` is `{country, region, city, source}` and
 * `.strict()`. The legacy processor emitted eleven geo fields plus a
 * hashed IP onto its own sibling stream; this block rides on the spine
 * event itself, where every field is paid for by every consumer and
 * every ClickHouse row. Country / region / city are what destinations
 * and audiences actually key on. Latitude, postal code and accuracy
 * radius have no reader today, and a field with no reader on the spine
 * is storage cost plus a PII surface, not a feature — they stay
 * available on `GeoResult` for a future enricher version that has a
 * reason to stamp them.
 *
 * ## The block is never absent
 *
 * Every event gets a `geo` value, `null` included, and every non-null
 * value carries `source`. "Not attempted", "attempted, nothing found"
 * and "found" are three different facts, and a consumer that cannot
 * tell them apart cannot tell a geo outage from a population of
 * IP-less server-side events.
 */

import { hashIp, parseIp } from "./ip.js";
import { type IPLookup, SOURCE_NO_IP } from "./lookup.js";

/** This enricher's identity. Pinned by the runtime's manifest. */
export const ENRICHER_NAME = "sync-enrichment-geoip" as const;
export const ENRICHER_VERSION = "v1" as const;
export const ENRICHER_IDENTITY = Object.freeze({
  name: ENRICHER_NAME,
  version: ENRICHER_VERSION,
});

/** The `enrichment.geo` block, exactly as `geoEnrichmentSchema` types it. */
export interface GeoBlock {
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly source: string;
}

/**
 * What the enricher decided, for the runtime's logs and metrics.
 *
 * `ipHash` is populated only when an address was present and valid, and
 * exists purely so a log line can reference the address without
 * containing it. It is never stamped on the envelope — the `geo` block
 * has no field for it, deliberately (see `ip.ts`).
 */
export interface GeoOutcome {
  readonly geo: GeoBlock;
  readonly ipHash: string | null;
  /** `hit` resolved a location; `miss` consulted a backend and found none; `no_ip` had nothing to consult. */
  readonly kind: "hit" | "miss" | "no_ip";
}

/**
 * Resolve the geo block for one event.
 *
 * The decision table, complete:
 *
 *   no/invalid address      → all fields null, `source: "no_ip"`
 *   valid, backend missed   → all fields null, `source: <backend id>`
 *   valid, backend hit      → fields from the result, `source` from the
 *                             RESULT (not the backend), so a database
 *                             that version-stamps its own answers keeps
 *                             that provenance
 */
export function enrichGeo(input: { readonly ip: unknown; readonly lookup: IPLookup }): GeoOutcome {
  const address = parseIp(input.ip);
  if (address === null) {
    return { geo: emptyGeo(SOURCE_NO_IP), ipHash: null, kind: "no_ip" };
  }

  const ipHash = hashIp(address);
  const found = input.lookup.lookup(address);
  if (found === null) {
    // The backend's own id, so a fail-open no-op ("no_lookup") reads
    // differently from a wired database that simply had no record.
    return { geo: emptyGeo(input.lookup.id), ipHash, kind: "miss" };
  }

  return {
    geo: {
      country: found.country_code ?? null,
      region: found.region_code ?? found.region_name ?? null,
      city: found.city ?? null,
      source: found.source,
    },
    ipHash,
    kind: "hit",
  };
}

function emptyGeo(source: string): GeoBlock {
  return { country: null, region: null, city: null, source };
}
