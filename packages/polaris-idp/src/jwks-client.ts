/**
 * Vendored from @idp/jwt 2.13.2 (`src/jwks-client.ts`), commit 9b171ac.
 *
 * Adapted: the config object is required rather than falling back to the
 * upstream module singleton. Behaviour is otherwise unchanged.
 */

import * as jose from "jose";

import type { IdpConfig } from "./config.js";

/**
 * Wraps `jose.createRemoteJWKSet` with caching and forced refresh on unknown kid.
 * The jose library handles JWKS fetching, caching, and key selection internally.
 */
export class JwksClient {
  private jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;
  private readonly config: IdpConfig;

  constructor(config: IdpConfig) {
    this.config = config;
  }

  /**
   * Get the JWKS key resolver function.
   * jose's `createRemoteJWKSet` handles caching, background refresh,
   * and key-rotation (refetch on unknown kid) automatically.
   */
  getKeyResolver(): ReturnType<typeof jose.createRemoteJWKSet> {
    if (!this.jwks) {
      this.jwks = jose.createRemoteJWKSet(new URL(this.config.jwksUrl), {
        cooldownDuration: 30_000, // min 30s between refetches
        cacheMaxAge: this.config.jwksCacheTtlMs,
      });
    }
    return this.jwks;
  }

  /** Clear the cached JWKS (useful for tests). */
  clear(): void {
    this.jwks = null;
  }
}
