import { SecretReferenceParseError } from "./errors.js";
import { type SecretProvider, type SecretReference, isSecretProvider } from "./types.js";

/**
 * Maximum accepted length for the `ref` portion of a secret reference. Set
 * generously so Vault paths, ARNs, and long env var names all fit, but bounded
 * so a stray multi-kilobyte string never reaches a provider adapter.
 */
const MAX_REF_LENGTH = 512;

/**
 * Reserved characters that must not appear in a `ref` value. The set is
 * conservative: every adapter we ship or plan to ship uses ASCII-safe
 * identifiers, and rejecting whitespace / control characters catches the
 * common copy-paste mistakes (trailing newlines, smart-quote spaces) before
 * they hit the provider.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: explicit guard against control chars in refs.
const REF_DISALLOWED_PATTERN = /[\s\x00-\x1f\x7f]/;

/**
 * Parse a secret reference into its canonical `(provider, ref)` form.
 *
 * Accepted inputs:
 *
 *   - object form: `{ provider, ref }` — used when reading PostgreSQL rows
 *     where the two columns are already split.
 *   - string form: `"<provider>:<ref>"` — convenient for CLI flags and tests.
 *     The provider portion matches the `SecretProvider` enum exactly; the
 *     remainder (after the first colon) is treated as the ref verbatim so
 *     values that themselves contain colons (Vault paths, some ARNs) survive.
 *
 * The parser is intentionally strict — invalid input throws
 * `SecretReferenceParseError`. The error message never echoes the raw input
 * because misuse occasionally passes the *value* of a secret where the
 * reference was expected, and we do not want that value to land in logs.
 */
export function parseSecretReference(input: SecretReference | string): SecretReference {
  if (typeof input === "string") {
    return parseStringForm(input);
  }
  return validateObjectForm(input);
}

function parseStringForm(input: string): SecretReference {
  if (input.length === 0) {
    throw new SecretReferenceParseError("empty reference string");
  }
  const separatorIndex = input.indexOf(":");
  if (separatorIndex <= 0) {
    throw new SecretReferenceParseError(
      'string form must look like "<provider>:<ref>" with a non-empty provider',
    );
  }
  const providerPart = input.slice(0, separatorIndex);
  const refPart = input.slice(separatorIndex + 1);
  if (!isSecretProvider(providerPart)) {
    throw new SecretReferenceParseError(`unknown provider "${providerPart}"`);
  }
  return finalizeReference(providerPart, refPart);
}

function validateObjectForm(input: SecretReference): SecretReference {
  if (typeof input !== "object" || input === null) {
    throw new SecretReferenceParseError("reference must be an object or string");
  }
  const provider = (input as { provider: unknown }).provider;
  const ref = (input as { ref: unknown }).ref;
  if (typeof provider !== "string") {
    throw new SecretReferenceParseError("provider must be a string");
  }
  if (typeof ref !== "string") {
    throw new SecretReferenceParseError("ref must be a string");
  }
  if (!isSecretProvider(provider)) {
    throw new SecretReferenceParseError(`unknown provider "${provider}"`);
  }
  return finalizeReference(provider, ref);
}

function finalizeReference(provider: SecretProvider, ref: string): SecretReference {
  if (ref.length === 0) {
    throw new SecretReferenceParseError("ref must be a non-empty string");
  }
  if (ref.length > MAX_REF_LENGTH) {
    throw new SecretReferenceParseError(`ref exceeds maximum length (${MAX_REF_LENGTH} chars)`);
  }
  if (REF_DISALLOWED_PATTERN.test(ref)) {
    throw new SecretReferenceParseError("ref contains whitespace or control characters");
  }
  return Object.freeze({ provider, ref });
}

/**
 * Format a parsed reference back to its `<provider>:<ref>` string form. Useful
 * for CLI output, structured-log fields, and round-trip tests. The output is
 * safe to log — it contains the reference, not the resolved secret.
 */
export function formatSecretReference(reference: SecretReference): string {
  return `${reference.provider}:${reference.ref}`;
}
