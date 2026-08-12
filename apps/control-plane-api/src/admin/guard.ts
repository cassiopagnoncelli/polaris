/**
 * The admin session guard.
 *
 * Runs as a `preHandler` inside the `/admin` plugin scope only, so `/v1/*`
 * never sees a cookie-derived actor — the JSON API stays bearer-only and
 * cookie-blind, which is what makes CSRF a non-question there.
 *
 * Order of business, and each step's failure mode:
 *
 *   1. No token                       → 303 into the Idp flow (a browser, not
 *                                       an error)
 *   2. Token fails verification       → 303 into the Idp flow, reason logged
 *                                       rather than rendered: a dead session
 *                                       is not something the operator can act
 *                                       on, and with a live Idp session they
 *                                       land back on the page they asked for
 *   3. Role below `admin`             → 403 HTML, never a redirect: a signed-in
 *                                       operator who lacks the role would
 *                                       otherwise bounce between login and
 *                                       denial forever
 *   4. Otherwise                      → attach the actor and continue
 *
 * The actor it attaches is what lands in `audit_records`:
 * `{ source: "declared", label: <email> }`. `declared` because
 * `audit_records.actor_source` is a CHECK-constrained enum with no `idp`
 * member, and because the production-mutation gate allows exactly that
 * source. The email comes from the *signed, subject-bound* identity cookie —
 * never from the request — so it cannot be forged into someone else's name.
 *
 * Worth being explicit about, because it drives the whole mutation design:
 * **the production-mutation gate cannot refuse anyone who gets past this
 * guard.** Its only rule is `actor.source !== "declared"`, and every operator
 * here is `declared` by construction. Guardrails for mutations live in
 * `actions/`, not in the gate.
 */

import type { Passport } from "@polaris/idp";
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { MINIMUM_PLATFORM_ROLE } from "./config.js";
import { type AdminIdentity, type AdminIdentityCodec, bindIdentity } from "./identity.js";
import { type IdpAuth, IdpAuthError } from "./idp-auth.js";
import {
  type PlatformRoleName,
  platformRoleAtLeast,
  resolvePlatformRole,
} from "./platform-role.js";
import type { SessionRefresher } from "./refresh.js";
import {
  ADMIN_PREFIX,
  type CookieOptions,
  readIdentityCookie,
  readRefreshToken,
  readSessionToken,
  setSessionCookies,
  signInPath,
} from "./session.js";

export interface AdminContext {
  readonly passport: Passport;
  readonly identity: AdminIdentity | null;
  readonly role: PlatformRoleName;
  /** Display name for the header: email if known, else the Idp subject. */
  readonly label: string;
}

export interface AdminGuardDeps {
  readonly idpAuth: IdpAuth;
  readonly identityCodec: AdminIdentityCodec;
  /** Renders the 403 page. Injected to avoid a cycle with `pages/`. */
  readonly renderForbidden: (role: PlatformRoleName) => string;
  /** Redeems an expired session's refresh token. Omit to disable refresh. */
  readonly refresher?: SessionRefresher | undefined;
  /** Cookie attributes, for writing the rotated session back. */
  readonly cookieOptions: CookieOptions;
}

export function createAdminGuard(deps: AdminGuardDeps): preHandlerAsyncHookHandler {
  return async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Cookie only. An `Authorization: Bearer <idp access token>` cannot reach
    // here: the service-wide bearer hook in `../auth/bearer.ts` runs first on
    // every route and 401s anything that is not a `polaris_ot_<uuidv7>.<secret>`
    // operator token. `haws` accepts either because it has no such hook; here
    // the affordance would be unreachable code pretending to be a feature.
    // Operators wanting a terminal have the `polaris` CLI.
    const token = readSessionToken(request);
    if (token === undefined) {
      redirectToSignIn(request, reply, "signed_out");
      return;
    }

    let passport: Passport;
    try {
      passport = await deps.idpAuth.verifyAccessToken(token);
    } catch (error) {
      const reason = error instanceof IdpAuthError ? error.reason : "invalid_token";

      // Expiry is the one failure worth trying to recover from. A revoked or
      // malformed token is a decision Idp already made; re-presenting a
      // refresh token would not change it.
      const refreshed =
        reason === "token_expired" ? await tryRefresh(request, reply, deps) : undefined;
      if (refreshed === undefined) {
        redirectToSignIn(request, reply, reason);
        return;
      }
      passport = refreshed;
    }

    const role = resolvePlatformRole(passport);
    if (!platformRoleAtLeast(role, MINIMUM_PLATFORM_ROLE)) {
      request.log.warn(
        {
          event: "admin.access_denied",
          // `passport.userUuid` throws on a service token exactly as
          // `platformRole` does; `subject` is the safe reader.
          subject: passport.subject,
          platform_role: role,
          request_path: request.url,
        },
        "admin access denied: platform_role below admin",
      );
      await reply
        .code(403)
        .header("content-type", "text/html; charset=utf-8")
        .send(deps.renderForbidden(role));
      return;
    }

    const identity = bindIdentity(
      deps.identityCodec.decode(readIdentityCookie(request)),
      passport.subject,
    );

    request.adminContext = {
      passport,
      identity,
      role,
      label: identity?.email ?? passport.subject,
    };
    request.actor = {
      source: "declared",
      label: identity?.email ?? passport.subject,
    };
  };
}

/**
 * Redeem the refresh token and write the rotated session back.
 *
 * Returns the passport from the fresh access token, or `undefined` if the
 * session cannot be recovered — in which case the caller redirects to login.
 *
 * The rotated cookies are set on this same reply, so the operator's current
 * request completes normally instead of bouncing through Idp mid-form.
 */
async function tryRefresh(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AdminGuardDeps,
): Promise<Passport | undefined> {
  if (deps.refresher === undefined) return undefined;

  const refreshToken = readRefreshToken(request);
  if (refreshToken === undefined) return undefined;

  const result = await deps.refresher.refresh(refreshToken);
  if (!result.ok) {
    request.log.info({ reason: result.reason }, "admin session refresh failed");
    return undefined;
  }

  let passport: Passport;
  try {
    passport = await deps.idpAuth.verifyAccessToken(result.tokens.accessToken);
  } catch (error) {
    // Idp handed back something we cannot verify. Treat it as a dead session
    // rather than trusting an unverified token on the strength of its source.
    request.log.warn({ err: error }, "refreshed access token failed verification");
    return undefined;
  }

  setSessionCookies(
    reply,
    {
      accessToken: result.tokens.accessToken,
      expiresIn: result.tokens.expiresIn,
      // Rotated: the old refresh token is dead at Idp, so the cookie must be
      // replaced or the next refresh replays a retired grant.
      refreshToken: result.tokens.refreshToken,
    },
    deps.cookieOptions,
  );
  request.log.debug({ subject: passport.subject }, "admin session refreshed");
  return passport;
}

/**
 * Send the operator straight into the Idp flow, remembering where they were.
 *
 * The reason only reaches the log. It named a state the operator cannot do
 * anything about — the session is gone either way — and rendering it meant an
 * interstitial standing between them and the one provider this panel has.
 * Failures of the flow *itself* still stop at `/auth/login`, which is what
 * keeps a broken round trip from bouncing forever.
 */
function redirectToSignIn(request: FastifyRequest, reply: FastifyReply, reason: string): void {
  request.log.debug({ reason }, "admin session rejected");
  // Only same-origin GETs round-trip, so a crafted `next` cannot bounce an
  // operator off-site after login, and a POST is not something to replay.
  const next =
    request.method === "GET" && request.url.startsWith(ADMIN_PREFIX) ? request.url : null;
  void reply.redirect(signInPath(next), 303);
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin guard inside the `/admin` scope. Absent on `/v1/*`. */
    adminContext?: AdminContext;
  }
}
