/**
 * @polaris/idp — Idp access-token verification for Polaris services.
 *
 * A vendored subset of the private `@idp/jwt` package. See README.md for
 * provenance, what was left behind, and the upgrade procedure.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 */

export {
  DEFAULT_CLOCK_SKEW_SECONDS,
  DEFAULT_JWKS_CACHE_TTL_MS,
  type IdpConfig,
  idpConfig,
} from "./config.js";
export {
  ClientCredentialsError,
  ExpiredTokenError,
  IdpJwtError,
  InvalidAudienceError,
  InvalidIssuerError,
  InvalidSignatureError,
  NotAUserTokenError,
  RefreshError,
  RevokedTokenError,
  VerificationError,
} from "./errors.js";
export {
  type IdTokenClaims,
  IdTokenVerifier,
  type IdTokenVerifierOptions,
} from "./id-token.js";
export { JwksClient } from "./jwks-client.js";
export {
  LEGACY_PLATFORM_ROLE_CLAIM,
  Passport,
  PLATFORM_ROLE_CLAIM,
  type PlatformRole,
  type TokenPayload,
} from "./passport.js";
export {
  RefreshClient,
  type RefreshClientOptions,
  type RefreshResult,
} from "./refresh-client.js";
export { type RevocationChecker, Verifier, type VerifierOptions } from "./verifier.js";
