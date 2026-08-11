/**
 * ID-token verification.
 *
 * Not vendored from upstream — `@idp/jwt` verifies access tokens only. Added
 * here rather than in the consuming service so that `jose` stays behind this
 * package's boundary and every Idp token rule lives in one place.
 *
 * An ID token is not an access token and cannot go through `Verifier`:
 *
 *   | | access token | ID token |
 *   | --- | --- | --- |
 *   | `typ` header | `at+jwt` (RFC 9068) | absent entirely |
 *   | `aud` | the platform audience (= issuer) | the client's `client_id` |
 *   | carries | authorization data | profile claims |
 *
 * Idp signs both with the same key, so the JWKS is shared.
 *
 * Why verify at all: the token arrives on a TLS backchannel response to a
 * client-authenticated request, which OIDC Core §3.1.3.7 says is sufficient
 * on its own. It is verified anyway because the email it yields is what a
 * consumer records as the acting operator, and a value that ends up in an
 * audit trail should not rest on transport alone.
 */

import * as jose from "jose";

export interface IdTokenClaims {
  /** Idp user uuid. Must match the access token's `sub` before being trusted. */
  readonly sub: string;
  readonly email: string | null;
  readonly name: string | null;
}

export interface IdTokenVerifierOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  /** The OAuth `client_id` these ID tokens are addressed to. */
  readonly clientId: string;
  readonly clockSkewSeconds?: number;
  readonly jwksCacheTtlMs?: number;
}

export class IdTokenVerifier {
  private readonly keys: ReturnType<typeof jose.createRemoteJWKSet>;

  constructor(private readonly options: IdTokenVerifierOptions) {
    this.keys = jose.createRemoteJWKSet(new URL(options.jwksUrl), {
      cooldownDuration: 30_000,
      cacheMaxAge: options.jwksCacheTtlMs ?? 3_600_000,
    });
  }

  /**
   * Verify an ID token and read its profile claims.
   *
   * Returns `null` on any failure rather than throwing. A bad ID token costs
   * the caller a display name and a logout hint, not a session — the access
   * token is the credential. Failing soft keeps an otherwise-valid sign-in
   * from being refused over a cosmetic claim.
   */
  async verify(idToken: string): Promise<IdTokenClaims | null> {
    try {
      const { payload } = await jose.jwtVerify(idToken, this.keys, {
        issuer: this.options.issuer,
        audience: this.options.clientId,
        algorithms: ["ES256"],
        clockTolerance: this.options.clockSkewSeconds ?? 30,
      });
      const sub = payload.sub;
      if (typeof sub !== "string" || sub.length === 0) return null;
      const email = payload["email"];
      const name = payload["name"];
      return {
        sub,
        email: typeof email === "string" ? email : null,
        name: typeof name === "string" ? name : null,
      };
    } catch {
      return null;
    }
  }
}
