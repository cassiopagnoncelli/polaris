/**
 * Shared validation for the `polaris destinations` command group.
 *
 * The central rule for P6-004:
 *
 *   The CLI MUST refuse to write mapping semantics. Mapping semantics
 *   (event-to-vendor field maps) live in versioned consumer code under
 *   `sync/destinations/<vendor>/<version>/src/mapper.ts` — NEVER in PostgreSQL.
 *
 * This module enforces that contract before any value reaches the DB
 * repository, for the CLI's flag surface.
 *
 * The token list itself moved to `@polaris/shared-control-plane` when
 * `destinations.config` and `project_config.value` landed: those are `jsonb`,
 * so the rule now has to be enforced on the KEYS of a bag at the database
 * layer too, and the database layer cannot import from `apps/`. It is
 * re-exported here under its original name so existing imports and the
 * structural tests in `destinations-commands.test.ts` keep working.
 *
 * @see docs/architecture/06-destinations.md "Mapping Semantics"
 * @see packages/shared-control-plane/src/mapping-tokens.ts
 * @see docs/implementation/tasks/P6-004-destination-instance-cli.md
 */
import {
  FORBIDDEN_MAPPING_FLAG_TOKENS,
  normaliseMappingToken,
} from "@polaris/shared-control-plane";
import { UsageError } from "../../errors.js";

export { FORBIDDEN_MAPPING_FLAG_TOKENS };

/** @deprecated Use `normaliseMappingToken` from `@polaris/shared-control-plane`. */
const normaliseFlagName = normaliseMappingToken;

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
          "consumer code under sync/destinations/<vendor>/<version>/src/mapper.ts and are NEVER " +
          "stored in PostgreSQL. To change a destination's runtime knobs, use " +
          "`polaris destinations update-ops` with --max-concurrency, --max-rps, " +
          "--retry-policy, or --dead-letter-threshold.",
      );
    }
  }
}

/**
 * Validate a `--secret-value`: the vendor credential itself.
 *
 * Non-empty is the only rule, matching the `destinations_secret_value_present`
 * CHECK, and that is on purpose. Its predecessor validated a
 * `<provider>:<reference>` shape because the column held a pointer with a
 * platform-defined format. A credential has no platform-defined format — it is
 * whatever the vendor issues, and each consumer asserts its own shape in
 * `parseResolvedSecret` at delivery time.
 *
 * Note the error message quotes the flag name, never the value. On this path
 * the value is a live credential, so echoing it back would put it in terminal
 * scrollback and in whatever captured the CLI's stderr.
 */
export function validateSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new UsageError(
      "--secret-value must be a non-empty credential. " +
        "This is the credential itself (for meta-capi, the " +
        '{"pixel_id":…,"access_token":…} JSON), not a reference to one.',
    );
  }
  return trimmed;
}
