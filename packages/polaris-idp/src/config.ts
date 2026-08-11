/**
 * Verifier configuration.
 *
 * Replaces upstream `@idp/jwt`'s `configuration.ts`, which keeps a mutable
 * module-level singleton (`configure()` / `getConfig()` / `resetConfig()`).
 * Polaris services pass configuration explicitly — `docs/instructions/claude.md`
 * requires env reading to go through `@polaris/shared-config`, and a global
 * singleton makes two differently-configured verifiers in one process
 * impossible (which the test suite needs).
 *
 * The revocation, blocklist, and catch-up fields upstream carries are absent:
 * the revocation subscriber is not vendored. See README.md.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 */

/** Default JWKS cache TTL, matching upstream: 1 hour. */
export const DEFAULT_JWKS_CACHE_TTL_MS = 3_600_000;

/** Default clock-skew tolerance for `exp`/`iat`, matching upstream: 30s. */
export const DEFAULT_CLOCK_SKEW_SECONDS = 30;

export interface IdpConfig {
  /** Idp JWKS endpoint, e.g. `https://account.example.com/.well-known/jwks.json`. */
  readonly jwksUrl: string;
  /** Expected `iss` claim. Tokens from another issuer are refused. */
  readonly issuer: string;
  /**
   * Expected `aud` claim. Idp's single logical platform audience defaults to
   * the issuer string on both sides (idp ADR-0001), so `null` is correct
   * unless idp runs with a custom `JWT_AUDIENCE`.
   */
  readonly audience: string | null;
  /** JWKS cache TTL in milliseconds. */
  readonly jwksCacheTtlMs: number;
  /** Clock-skew tolerance in seconds for `exp`/`iat` validation. */
  readonly clockSkewSeconds: number;
}

/**
 * Fill an `IdpConfig` from the two fields that have no sensible default.
 * Mirrors upstream's `defaults` object for the fields that survive vendoring.
 */
export function idpConfig(
  input: Pick<IdpConfig, "jwksUrl" | "issuer"> & Partial<IdpConfig>,
): IdpConfig {
  if (input.jwksUrl.length === 0) throw new Error("idpConfig: jwksUrl is required");
  if (input.issuer.length === 0) throw new Error("idpConfig: issuer is required");
  return {
    jwksUrl: input.jwksUrl,
    issuer: input.issuer,
    audience: input.audience ?? null,
    jwksCacheTtlMs: input.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS,
    clockSkewSeconds: input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS,
  };
}
