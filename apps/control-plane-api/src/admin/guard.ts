/**
 * The admin session guard.
 *
 * Runs as a `preHandler` inside the `/admin` plugin scope only, so `/v1/*`
 * never sees a cookie-derived actor — the JSON API stays bearer-only and
 * cookie-blind, which is what makes CSRF a non-question there.
 *
 * Order of business, and each step's failure mode:
 *
 *   1. No token                       → 302 to login (a browser, not an error)
 *   2. Token fails verification       → 302 to login, with the reason in the
 *                                       query so the page can say *why* the
 *                                       session ended rather than looping
 *                                       silently
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
import { AUTH_PREFIX, readIdentityCookie, readSessionToken } from "./session.js";

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
}

/** Signals the plugin should send the operator back to the IdP. */
export const LOGIN_PATH = `${AUTH_PREFIX}/login` as const;

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
      redirectToLogin(request, reply, "signed_out");
      return;
    }

    let passport: Passport;
    try {
      passport = await deps.idpAuth.verifyAccessToken(token);
    } catch (error) {
      const reason = error instanceof IdpAuthError ? error.reason : "invalid_token";
      request.log.debug({ reason }, "admin session rejected");
      redirectToLogin(request, reply, reason);
      return;
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

function redirectToLogin(request: FastifyRequest, reply: FastifyReply, reason: string): void {
  const params = new URLSearchParams({ reason });
  // Only same-origin paths round-trip, so a crafted `next` cannot bounce an
  // operator off-site after login.
  if (request.method === "GET" && request.url.startsWith("/admin")) {
    params.set("next", request.url);
  }
  void reply.redirect(`${LOGIN_PATH}?${params.toString()}`, 303);
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin guard inside the `/admin` scope. Absent on `/v1/*`. */
    adminContext?: AdminContext;
  }
}
