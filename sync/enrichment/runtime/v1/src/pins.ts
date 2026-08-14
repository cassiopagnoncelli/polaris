/**
 * The enricher pin-set: which enricher versions this runtime composes.
 *
 * Mirrors `descriptor-identity.ts` in a destination consumer, which
 * pins `normalize_version` / `mapper_version` / `deliverer_version` as
 * `as const` literals the runtime stamps onto every delivery record. The
 * enrichment stage has the same shape of problem — several independently
 * versioned units inside one process — and one difference: its unit list
 * is open-ended, so the pins are a list rather than three fixed scalars.
 *
 * ## Why the pins are asserted against the manifest and the enrichers
 *
 * Destinations restate their versions in `consumer.manifest.yaml`, which
 * nothing parses; the YAML and the TypeScript can disagree silently, and
 * the YAML is what an auditor reads. This stage closes that gap:
 * `test/manifest.test.ts` asserts this constant equals the manifest's
 * `composes:` block AND that each entry equals the enricher package's
 * own `ENRICHER_IDENTITY`. Three statements of the same fact, checked
 * against each other, so a version bump that updates only one of them
 * fails the build rather than shipping a manifest that lies.
 */

import { ENRICHER_IDENTITY as GEOIP_IDENTITY } from "@polaris/sync-enrichment-geoip-v1";
import { ENRICHER_IDENTITY as TRAITS_IDENTITY } from "@polaris/sync-enrichment-traits-v1";

/** This stage's own identity — the processor, not its parts. */
export const PROCESSOR_NAME = "sync-enrichment-runtime" as const;
export const PROCESSOR_VERSION = "v1" as const;
export const PROCESSOR_IDENTITY = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
});

/** One composed unit, as the manifest's `composes:` entries declare it. */
export interface EnricherPin {
  readonly name: string;
  readonly version: string;
}

/**
 * The composed units, in the order the runtime applies them.
 *
 * Order is not arbitrary, though today it is also not contentious: the
 * two enrichers write disjoint slots (`profile.traits` and
 * `enrichment.geo`) and neither reads the other's output, so the result
 * is order-independent. Recording an order anyway is cheap, and the
 * first enricher that wants to read another's output will need one.
 */
export const ENRICHER_PINS: readonly EnricherPin[] = Object.freeze([
  { name: TRAITS_IDENTITY.name, version: TRAITS_IDENTITY.version },
  { name: GEOIP_IDENTITY.name, version: GEOIP_IDENTITY.version },
]);
