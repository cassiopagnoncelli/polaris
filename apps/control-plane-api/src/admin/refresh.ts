/**
 * Silent access-token refresh.
 *
 * Idp access tokens live 15 minutes. Without this, an operator gets thrown
 * through a full OAuth redirect every 15 minutes — including mid-form, which
 * loses whatever they had typed. `haws` holds a 30-day refresh token cookie
 * it never once uses; this does not repeat that.
 *
 * The hazard is rotation. Idp issues a **new** refresh token on every
 * successful refresh and retires the old one, so two concurrent requests that
 * both find an expired access token would race to redeem the same refresh
 * token: one wins, the other gets `invalid_grant`, and — worse — the loser may
 * overwrite the winner's fresh cookie with a dead one. A browser loading a
 * page plus its stylesheet is enough to trigger it.
 *
 * Hence single-flight: concurrent refreshes of the same token share one
 * in-flight promise, so exactly one redemption happens and every caller gets
 * the same result. The entry is dropped as soon as it settles — this is
 * request coalescing, not a cache, and a stored result would be a rotated
 * token waiting to be replayed.
 */

import { RefreshClient, RefreshError, type RefreshResult } from "@polaris/idp";

import type { AdminIdpConfig } from "./config.js";

export type { RefreshResult };

/** Why a refresh did not produce a new session. */
export type RefreshFailure =
  /** Idp refused the grant: revoked, expired, replayed, or wrong client. Only a fresh login recovers. */
  | "invalid_grant"
  /** Network, timeout, or 5xx. The grant is presumed live; the operator can retry. */
  | "transient";

export interface SessionRefresher {
  /**
   * Redeem a refresh token, or explain why not.
   *
   * Never throws: the caller is a request guard whose fallback in every
   * failure case is the same redirect to login.
   */
  refresh(
    refreshToken: string,
  ): Promise<{ ok: true; tokens: RefreshResult } | { ok: false; reason: RefreshFailure }>;
}

export function createSessionRefresher(config: AdminIdpConfig): SessionRefresher {
  const client = new RefreshClient({
    tokenUrl: config.tokenUrl,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    httpTimeoutMs: config.requestTimeoutMs,
  });
  return wrapSingleFlight((token) => client.refresh(token));
}

/**
 * Exported for tests, which supply a fake redeemer to assert the coalescing
 * behaviour without a live Idp.
 */
export function wrapSingleFlight(
  redeem: (refreshToken: string) => Promise<RefreshResult>,
): SessionRefresher {
  const inFlight = new Map<string, Promise<Awaited<ReturnType<SessionRefresher["refresh"]>>>>();

  return {
    async refresh(refreshToken) {
      const existing = inFlight.get(refreshToken);
      if (existing !== undefined) return existing;

      const attempt = (async (): Promise<Awaited<ReturnType<SessionRefresher["refresh"]>>> => {
        try {
          return { ok: true, tokens: await redeem(refreshToken) };
        } catch (error) {
          if (error instanceof RefreshError) {
            return { ok: false, reason: error.transient ? "transient" : "invalid_grant" };
          }
          return { ok: false, reason: "transient" };
        }
      })();

      inFlight.set(refreshToken, attempt);
      try {
        return await attempt;
      } finally {
        // Drop immediately. Keeping the result would hand a rotated — and
        // therefore dead — refresh token to the next caller.
        inFlight.delete(refreshToken);
      }
    },
  };
}
