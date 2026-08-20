/**
 * The mapping-semantics prohibition, in one place.
 *
 * Polaris's central architectural rule is that PostgreSQL never stores
 * event-to-vendor mapping semantics: those live in
 * `sync/destinations/<vendor>/<version>/src/mapper.ts` under review, not in a row an operator
 * can edit. For most of the platform's life that rule was enforced
 * *structurally* — the schema simply had no column to put a mapping in, and
 * `apps/polaris-cli/test/destinations-commands.test.ts` asserts exactly that.
 *
 * `destinations.config` and `project_config.value` are `jsonb`, which changes
 * the shape of the problem. A bag has somewhere to hide a field map, so column
 * absence no longer carries the guarantee on its own. What replaces it is a
 * check on KEYS at every write path — which is why this list had to leave
 * `apps/polaris-cli/` (where the database layer cannot import it) and live
 * here, reachable from both the CLI and `@polaris/shared-control-plane-db`.
 *
 * @see docs/implementation/project-config-plan.md §2
 * @see db/migrations/20260813000002_add_destinations_config.sql
 */

/**
 * Flag, argument, and configuration-key tokens that look like an attempt to
 * declare mapping semantics.
 *
 * Matching is case-insensitive and covers the flag form (`--field-map`), the
 * camelCase form commander stores (`fieldMap`), and the snake_case form a
 * config key would use (`field_map`) — hence both spellings appear in the
 * list rather than being normalised into one.
 */
export const FORBIDDEN_MAPPING_FLAG_TOKENS: readonly string[] = [
  "map",
  "maps",
  "mapping",
  "mappings",
  "field-map",
  "field_map",
  "fieldmap",
  "field-mapping",
  "field_mapping",
  "fieldmapping",
  "event-map",
  "event_map",
  "eventmap",
  "event-mapping",
  "event_mapping",
  "eventmapping",
  "target-field",
  "target_field",
  "targetfield",
  "vendor-field",
  "vendor_field",
  "vendorfield",
  "canonical-field",
  "canonical_field",
  "canonicalfield",
  "property-map",
  "property_map",
  "propertymap",
];

/**
 * Normalise a flag / option / config-key name into the shape
 * {@link FORBIDDEN_MAPPING_FLAG_TOKENS} is written in.
 *
 * Underscores are deliberately NOT folded into hyphens: the token list carries
 * both spellings, and folding here would silently change which inputs match.
 */
export function normaliseMappingToken(name: string): string {
  return name
    .replace(/^--?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Segment words that make a name a map regardless of what precedes them.
 *
 * The exact-name list above cannot cover the space: it was written by
 * enumerating the names someone had reached for, so `field_map` is refused
 * while `routing_map` — same semantics, coined later — was accepted. Any
 * name whose LAST `_`/`-` segment is one of these is a map by construction,
 * and no legitimate parameter ends that way (`sitemap` and `heatmap` are
 * single words, not segments, and are unaffected).
 */
const MAPPING_SUFFIX_SEGMENTS: readonly string[] = ["map", "maps", "mapping", "mappings"];

/** Whether a single name is a forbidden mapping token. */
export function isMappingToken(name: string): boolean {
  const normalised = normaliseMappingToken(name);
  if (FORBIDDEN_MAPPING_FLAG_TOKENS.includes(normalised)) return true;
  const segments = normalised.split(/[-_]/);
  const last = segments[segments.length - 1];
  return segments.length > 1 && last !== undefined && MAPPING_SUFFIX_SEGMENTS.includes(last);
}

/** Raised when a write would have stored mapping semantics. */
export class MappingSemanticsError extends Error {
  public readonly token: string;
  public readonly context: string;

  constructor(token: string, context: string) {
    super(
      `"${token}" is not accepted by ${context}: event-to-vendor mapping semantics live in ` +
        "sync/destinations/<vendor>/<version>/src/mapper.ts, never in PostgreSQL",
    );
    this.name = "MappingSemanticsError";
    this.token = token;
    this.context = context;
  }
}

/**
 * Throw if any of `keys` looks like mapping semantics.
 *
 * Call this BEFORE any database write, so a rejected write leaves no trace —
 * the property `destinations-commands.test.ts` already asserts for CLI flags,
 * now extended to the keys of a jsonb bag.
 */
export function assertNoMappingSemantics(keys: readonly string[], context: string): void {
  for (const key of keys) {
    if (isMappingToken(key)) throw new MappingSemanticsError(key, context);
  }
}
