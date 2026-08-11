/**
 * Vendored from @idp/jwt 2.13.2 (`src/verifier.ts`), commit 9b171ac.
 *
 * Adapted in two places:
 *   1. The config object is required rather than falling back to the upstream
 *      module singleton.
 *   2. `revocationSubscriber` is typed as the structural `RevocationChecker`
 *      below instead of importing upstream's 1062-line `RevocationSubscriber`
 *      (which pulls in `redis` + `amqplib`). Polaris does not vendor the
 *      subscriber — see README.md — but the seam stays open so one can be
 *      passed in later without touching this file.
 *
 * The verification steps, the jose error mapping, and the revocation
 * semantics are unchanged.
 */

import * as jose from "jose";

import type { IdpConfig } from "./config.js";
import {
  ExpiredTokenError,
  InvalidAudienceError,
  InvalidIssuerError,
  InvalidSignatureError,
  RevokedTokenError,
  VerificationError,
} from "./errors.js";
import { JwksClient } from "./jwks-client.js";
import { Passport, type TokenPayload } from "./passport.js";

/**
 * The one method `Verifier` needs from a revocation source. Upstream's
 * `RevocationSubscriber` satisfies this shape structurally, so it can be
 * dropped in unchanged if the subscriber is ever vendored.
 */
export interface RevocationChecker {
  isRevoked(subject: string, issuedAtSec?: number, sid?: string | null): boolean;
}

export interface VerifierOptions {
  config: IdpConfig;
  jwksClient?: JwksClient;
  revocationSubscriber?: RevocationChecker | null;
}

export class Verifier {
  private readonly config: IdpConfig;
  private readonly jwksClient: JwksClient;
  private readonly revocationSubscriber: RevocationChecker | null;

  constructor(options: VerifierOptions) {
    this.config = options.config;
    this.jwksClient = options.jwksClient ?? new JwksClient(this.config);
    this.revocationSubscriber = options.revocationSubscriber ?? null;
  }

  /**
   * Verify a JWT access token and return a Passport.
   *
   * @param token - The encoded JWT (optionally prefixed with "Bearer ")
   * @returns A verified Passport
   * @throws {VerificationError} on any validation failure
   */
  async verify(token: string): Promise<Passport> {
    const rawToken = token.replace(/^Bearer\s+/i, "");
    const keyResolver = this.jwksClient.getKeyResolver();

    let payload: jose.JWTPayload;

    try {
      // RFC 9068: only at+jwt-typed tokens are access tokens (ID tokens
      // and foreign JWTs are rejected), audience-bound to the platform
      // audience (defaults to the issuer string, matching idp).
      const result = await jose.jwtVerify(rawToken, keyResolver, {
        issuer: this.config.issuer,
        audience: this.config.audience ?? this.config.issuer,
        typ: "at+jwt",
        algorithms: ["ES256"],
        clockTolerance: this.config.clockSkewSeconds,
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof jose.errors.JWTExpired) {
        throw new ExpiredTokenError();
      }
      if (err instanceof jose.errors.JWTClaimValidationFailed) {
        if (err.claim === "iss") {
          throw new InvalidIssuerError();
        }
        if (err.claim === "aud") {
          throw new InvalidAudienceError();
        }
        throw new VerificationError(err.message);
      }
      if (
        err instanceof jose.errors.JWSSignatureVerificationFailed ||
        err instanceof jose.errors.JWKSNoMatchingKey
      ) {
        throw new InvalidSignatureError();
      }
      throw new VerificationError(err instanceof Error ? err.message : "Token verification failed");
    }

    const passport = new Passport(payload as unknown as TokenPayload);

    this.checkRevocation(passport);

    return passport;
  }

  private checkRevocation(passport: Passport): void {
    if (!this.revocationSubscriber) return;
    // Service tokens (client_credentials) are short-lived and not tracked
    // in the revocation channel. Skip the lookup entirely.
    if (passport.service) return;

    // `iat` decides whether THIS token is one of the revoked ones (a passport
    // minted after the revocation belongs to a sign-in that came later and was
    // never revoked), and `sid` which session it speaks for — ending one
    // session is no reason to refuse the subject's others.
    if (this.revocationSubscriber.isRevoked(passport.subject, passport.claims.iat, passport.sid)) {
      throw new RevokedTokenError();
    }
  }
}
