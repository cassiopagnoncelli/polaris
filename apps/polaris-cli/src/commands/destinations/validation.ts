/**
 * Shared validation for the `polaris destinations` command group.
 *
 * The central rule for P6-004:
 *
 *   The CLI MUST refuse to write mapping semantics. Mapping semantics
 *   (event-to-vendor field maps) live in versioned consumer code under
 *   `consumers/<vendor>/v<n>/mappers/` — NEVER in PostgreSQL.
 *
 * This module enforces that contract before any value reaches the DB
 * repository. The rejection list of disallowed flag/argument names lives
 * here so every command in the group enforces the same gate.
 *
 * @see docs/architecture/06-destinations.md "Mapping Semantics"
 * @see docs/implementation/tasks/P6-004-destination-instance-cli.md
 */
import { UsageError } from "../../errors.js";

/**
 * Flag and argument tokens that look like an attempt to declare mapping
 * semantics. If the CLI ever receives one of these, every destinations
 * command rejects with a usage error BEFORE any DB write happens.
 *
 * The match is case-insensitive and matches both the flag form
 * (`--field-map`) and the underlying option name commander stores
 * (`fieldMap`).
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
 * Normalise a flag/option name into the same shape as
 * {@link FORBIDDEN_MAPPING_FLAG_TOKENS}. commander stores option names in
 * camelCase (`--field-map` -> `fieldMap`), so we lowercase and convert
 * camelCase boundaries to hyphens before comparing.
 */
function normaliseFlagName(name: string): string {
  return name
    .replace(/^--?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Reject any flag/argument token that looks like an attempt to define
 * mapping semantics. Used by:
 *
 *   - `polaris destinations create` (rejects extra positional/option args)
 *   - `polaris destinations update-ops` (only operational tuning allowed)
 *
 * Throws {@link UsageError} so the dispatcher returns exit code 2 and the
 * caller can detect the rejection in scripts.
 */
export function rejectMappingArguments(args: Readonly<Record<string, unknown>>): void {
  for (const rawKey of Object.keys(args)) {
    const value = args[rawKey];
    if (value === undefined) continue;
    const normalised = normaliseFlagName(rawKey);
    if (FORBIDDEN_MAPPING_FLAG_TOKENS.includes(normalised)) {
      throw new UsageError(
        `--${normalised} is not accepted by the destinations CLI. ` +
          "Mapping semantics (event-to-vendor field maps) live in versioned " +
          "consumer code under consumers/<vendor>/v<n>/mappers/ and are NEVER " +
          "stored in PostgreSQL. To change a destination's runtime knobs, use " +
          "`polaris destinations update-ops` with --max-concurrency, --max-rps, " +
          "--retry-policy, or --dead-letter-threshold.",
      );
    }
  }
}

/**
 * Validate a `--secret-ref` value. The value MUST be of the form
 * `<provider>:<reference>`, e.g.
 *
 *   env:META_CAPI_TOKEN_STOREFRONT_PROD
 *   secret_manager:polaris/production/storefront/meta-capi
 *   vault:secret/data/polaris/meta-capi
 *
 * Plaintext secrets must never be passed here. The CLI does not detect
 * "secret-shaped" values — operator hygiene plus the
 * `destinations_secret_ref_format` CHECK constraint catch obvious mistakes.
 */
export function validateSecretRef(value: string): { provider: string; ref: string } {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0 || idx === trimmed.length - 1) {
    throw new UsageError(
      `--secret-ref must be in the form <provider>:<reference> (got "${value}"). ` +
        "Examples: env:META_CAPI_TOKEN_STOREFRONT_PROD, " +
        "secret_manager:polaris/production/storefront/meta-capi. " +
        "Plaintext secrets are never accepted.",
    );
  }
  const provider = trimmed.slice(0, idx);
  const ref = trimmed.slice(idx + 1);
  if (!/^[a-z][a-z0-9_-]*$/.test(provider)) {
    throw new UsageError(
      `--secret-ref provider "${provider}" is invalid. ` +
        "Allowed shape: lowercase alphanumeric with underscores or hyphens.",
    );
  }
  if (ref.length === 0 || /\s/.test(ref)) {
    throw new UsageError(
      `--secret-ref reference "${ref}" is invalid. ` +
        "Must be non-empty and contain no whitespace.",
    );
  }
  return { provider, ref };
}
