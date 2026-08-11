/**
 * Admin cookie names, attributes, and read/write helpers.
 *
 * Five cookies, in two groups with different lifetimes and scopes:
 *
 *   Path=/admin        session (access token), refresh, identity
 *   Path=/admin/auth   oauth state, pkce verifier
 *
 * The narrower path on the flow cookies keeps them off every ordinary page
 * request; they exist for one redirect round trip and are cleared on every
 * exit from the callback.
 *
 * **SameSite=Lax, not Strict.** The Idp callback is a cross-site top-level
 * GET, and `Strict` would withhold the state and PKCE cookies precisely when
 * the callback needs to read them — the flow would fail every time. `Lax`
 * still blocks cross-site POST, which is the CSRF case that matters; the
 * `Origin` check in `origin.ts` is the defence-in-depth layer on top.
 *
 * Nothing here is encrypted. The access token is a signed JWT and the refresh
 * token is opaque to the browser; `HttpOnly` plus TLS is the protection. The
 * identity cookie is the one that is *signed*, because its email is what
 * lands in `audit_records.actor_label` — see `identity.ts`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "polaris_admin_session" as const;
export const REFRESH_COOKIE = "polaris_admin_refresh" as const;
export const IDENTITY_COOKIE = "polaris_admin_identity" as const;
export const STATE_COOKIE = "polaris_admin_state" as const;
export const PKCE_COOKIE = "polaris_admin_pkce" as const;
export const NEXT_COOKIE = "polaris_admin_next" as const;

/** Mount point. Both cookie paths and every route derive from it. */
export const ADMIN_PREFIX = "/admin" as const;
export const AUTH_PREFIX = `${ADMIN_PREFIX}/auth` as const;

/** The OAuth round trip is a redirect pair, not a session. Five minutes is generous. */
const FLOW_COOKIE_MAX_AGE_SEC = 300;

/** Refresh tokens live 30 days at Idp for a persistent grant. */
const REFRESH_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

/**
 * Floor on the session cookie's lifetime.
 *
 * Idp reports `expires_in` for the access token (900s). If it ever reports
 * something tiny, a cookie that expires mid-redirect would loop the operator
 * through login forever.
 */
const MIN_SESSION_MAX_AGE_SEC = 60;

export interface CookieOptions {
  readonly secure: boolean;
}

interface SetOptions {
  readonly path: string;
  readonly maxAge: number;
  readonly secure: boolean;
}

function setCookie(reply: FastifyReply, name: string, value: string, options: SetOptions): void {
  reply.setCookie(name, value, {
    path: options.path,
    httpOnly: true,
    sameSite: "lax",
    secure: options.secure,
    maxAge: options.maxAge,
  });
}

function clearCookie(reply: FastifyReply, name: string, path: string, secure: boolean): void {
  reply.clearCookie(name, { path, httpOnly: true, sameSite: "lax", secure });
}

function read(request: FastifyRequest, name: string): string | undefined {
  const value = request.cookies[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

// ---- flow cookies (state + PKCE) ---------------------------------------

export function setFlowCookies(
  reply: FastifyReply,
  input: { state: string; codeVerifier: string; next?: string | undefined },
  options: CookieOptions,
): void {
  const shape = { path: AUTH_PREFIX, maxAge: FLOW_COOKIE_MAX_AGE_SEC, secure: options.secure };
  setCookie(reply, STATE_COOKIE, input.state, shape);
  setCookie(reply, PKCE_COOKIE, input.codeVerifier, shape);
  // The post-login destination has to survive the round trip somewhere, and
  // Idp echoes back only `state` and `code` — not arbitrary parameters. A
  // cookie beside the other flow cookies is the least surprising place, and
  // it is re-validated as a same-origin admin path on the way out.
  if (input.next !== undefined) setCookie(reply, NEXT_COOKIE, input.next, shape);
}

export function readFlowCookies(request: FastifyRequest): {
  state: string | undefined;
  codeVerifier: string | undefined;
  next: string | undefined;
} {
  return {
    state: read(request, STATE_COOKIE),
    codeVerifier: read(request, PKCE_COOKIE),
    next: read(request, NEXT_COOKIE),
  };
}

/**
 * Clear both flow cookies.
 *
 * The callback calls this on **every** exit path, before deciding anything
 * else. A verifier left behind after a failed exchange is a verifier waiting
 * to be paired with whatever code turns up next.
 */
export function clearFlowCookies(reply: FastifyReply, options: CookieOptions): void {
  clearCookie(reply, STATE_COOKIE, AUTH_PREFIX, options.secure);
  clearCookie(reply, PKCE_COOKIE, AUTH_PREFIX, options.secure);
  clearCookie(reply, NEXT_COOKIE, AUTH_PREFIX, options.secure);
}

// ---- session cookies ----------------------------------------------------

export function setSessionCookies(
  reply: FastifyReply,
  input: {
    accessToken: string;
    expiresIn: number;
    refreshToken?: string | undefined;
    identity?: string | undefined;
  },
  options: CookieOptions,
): void {
  const maxAge = Math.max(input.expiresIn, MIN_SESSION_MAX_AGE_SEC);
  setCookie(reply, SESSION_COOKIE, input.accessToken, {
    path: ADMIN_PREFIX,
    maxAge,
    secure: options.secure,
  });
  if (input.identity !== undefined) {
    setCookie(reply, IDENTITY_COOKIE, input.identity, {
      path: ADMIN_PREFIX,
      maxAge,
      secure: options.secure,
    });
  }
  if (input.refreshToken !== undefined) {
    setCookie(reply, REFRESH_COOKIE, input.refreshToken, {
      path: ADMIN_PREFIX,
      maxAge: REFRESH_COOKIE_MAX_AGE_SEC,
      secure: options.secure,
    });
  }
}

export function readSessionToken(request: FastifyRequest): string | undefined {
  return read(request, SESSION_COOKIE);
}

export function readRefreshToken(request: FastifyRequest): string | undefined {
  return read(request, REFRESH_COOKIE);
}

export function readIdentityCookie(request: FastifyRequest): string | undefined {
  return read(request, IDENTITY_COOKIE);
}

export function clearSessionCookies(reply: FastifyReply, options: CookieOptions): void {
  clearCookie(reply, SESSION_COOKIE, ADMIN_PREFIX, options.secure);
  clearCookie(reply, IDENTITY_COOKIE, ADMIN_PREFIX, options.secure);
  clearCookie(reply, REFRESH_COOKIE, ADMIN_PREFIX, options.secure);
}
