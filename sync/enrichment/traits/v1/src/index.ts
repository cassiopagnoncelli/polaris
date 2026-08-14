/**
 * `@polaris/sync-enrichment-traits-v1` — the traits enricher.
 *
 * A library, not a service: `sync/enrichment/runtime` composes it
 * in-process and pins `sync-enrichment-traits v1` in its manifest.
 *
 * The package exports no write path to the profile store, and that is
 * the point — see `reader.ts`.
 */

export {
  DEFAULT_MAX_TRAITS_BYTES,
  ENRICHER_IDENTITY,
  ENRICHER_NAME,
  ENRICHER_VERSION,
  enrichTraits,
  type TraitsEnricherOptions,
  type TraitsOutcome,
} from "./enricher.js";
export {
  createKyselyProfileReader,
  type ProfileReader,
  type ProfileSnapshot,
} from "./reader.js";
