/**
 * Token verification against Idp.
 *
 * Ported from `haws/src/admin/idpAuth.ts`, minus the revocation subscriber
 * (see `libs/auth/README.md` for why Polaris does not carry it:
 * it needs redis + amqplib for a window shorter than the 15-minute
 * access-token TTL, and this service has neither dependency).
 *
 * Two different verifications happen here, and they are not interchangeable:
 *
 *   - **Access token** — RFC 9068: `typ: at+jwt`, `aud` = the platform
 *     audience (the issuer string). Verified on every request by the guard.
 *     This is the token that carries `platform_role`.
 *
 *   - **ID token** — OIDC: no `typ` header at all, `aud` = this client's
 *     `client_id`. Seen exactly once, at callback, and only to read the
 *     operator's email and name — access tokens carry no profile claims
 *     (idp ADR-0001). Also kept as the `id_token_hint` for logout.
 *
 * Verifying the ID token is belt-and-braces: it arrives on a TLS backchannel
 * response to a client-authenticated request, which OIDC Core §3.1.3.7 says
 * is sufficient on its own. It is verified anyway because the email it yields
 * becomes `audit_records.actor_label`, and a value that ends up in the audit
 * trail should not rest on transport alone.
 */

import {
  ExpiredTokenError,
  type IdpConfig,
  type IdTokenClaims,
  IdTokenVerifier,
  JwksClient,
  type Passport,
  RevokedTokenError,
  VerificationError,
  Verifier,
} from "@polaris/auth";

import type { AdminIdpConfig } from "./config.js";

/** Why a token was refused. Distinguished so the UI can say something useful. */
export type IdpAuthFailure = "token_expired" | "token_revoked" | "invalid_token";

export class IdpAuthError extends Error {
  constructor(
    message: string,
    readonly reason: IdpAuthFailure,
  ) {
    super(message);
    this.name = "IdpAuthError";
  }
}

export type { IdTokenClaims };

/**
 * The slice of Idp verification the admin plugin depends on.
 *
 * An interface rather than the concrete class so tests inject a stub and
 * never need a live Idp or a signing key — the same seam
 * `operatorTokenRepository` already provides for bearer auth.
 */
export interface IdpAuth {
  verifyAccessToken(token: string): Promise<Passport>;
  verifyIdToken(idToken: string): Promise<IdTokenClaims | null>;
}

export function createIdpAuth(config: AdminIdpConfig): IdpAuth {
  const verifierConfig: IdpConfig = {
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    // Idp's platform audience defaults to the issuer string on both sides
    // (idp ADR-0001), so null is correct unless JWT_AUDIENCE is customised.
    audience: null,
    jwksCacheTtlMs: 3_600_000,
    clockSkewSeconds: 30,
  };

  const verifier = new Verifier({
    config: verifierConfig,
    jwksClient: new JwksClient(verifierConfig),
  });

  // A second verifier for ID tokens. Same keys, different expectations (no
  // `typ` header, audience = client_id), so it cannot reuse `Verifier`.
  const idTokens = new IdTokenVerifier({
    jwksUrl: config.jwksUrl,
    issuer: config.issuer,
    clientId: config.clientId,
  });

  return {
    async verifyAccessToken(token: string): Promise<Passport> {
      try {
        return await verifier.verify(token);
      } catch (error) {
        if (error instanceof ExpiredTokenError) {
          throw new IdpAuthError("Access token has expired", "token_expired");
        }
        if (error instanceof RevokedTokenError) {
          throw new IdpAuthError("Access token has been revoked", "token_revoked");
        }
        if (error instanceof VerificationError) {
          throw new IdpAuthError("Invalid access token", "invalid_token");
        }
        throw new IdpAuthError("Token verification failed", "invalid_token");
      }
    },

    async verifyIdToken(idToken: string): Promise<IdTokenClaims | null> {
      return idTokens.verify(idToken);
    },
  };
}
