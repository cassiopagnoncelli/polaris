/**
 * `@polaris/sync-enrichment-geoip-v1` — the geo enricher.
 *
 * A library, not a service: `sync/enrichment/runtime` composes it
 * in-process and pins `sync-enrichment-geoip v1` in its manifest. One
 * broker hop for the whole enrichment stage, however many enrichers it
 * grows.
 */

export {
  ENRICHER_IDENTITY,
  ENRICHER_NAME,
  ENRICHER_VERSION,
  enrichGeo,
  type GeoBlock,
  type GeoOutcome,
} from "./enricher.js";
export { hashIp, parseIp } from "./ip.js";
export {
  type GeoResult,
  InMemoryIPLookup,
  type IPLookup,
  NoOpIPLookup,
  SOURCE_NO_IP,
  SOURCE_NO_LOOKUP,
} from "./lookup.js";
export {
  MaxmindIPLookup,
  mapCityResponse,
  type OpenMaxmindOutcome,
  openMaxmindLookup,
} from "./maxmind.js";
