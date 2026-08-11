/**
 * The admin UI, as an encapsulated Fastify plugin mounted at `/admin`.
 *
 * Encapsulation is the point, not an implementation detail. Everything this
 * plugin installs — the cookie parser, the urlencoded body parser, the HTML
 * error and not-found handlers, and the session guard — is scoped to this
 * subtree. So `/v1/*` stays exactly what it was: JSON, RFC 7807 errors, bearer
 * auth, and cookie-blind. An admin session cookie cannot authenticate the JSON
 * API, which is why that API needs no CSRF story at all.
 *
 * Two child scopes inside:
 *
 *   public   — the stylesheet and the whole OAuth flow. No guard: these are
 *              the routes an unauthenticated browser must reach.
 *   guarded  — every page. `createAdminGuard` runs as a preHandler here, so
 *              no page can accidentally ship without it. Adding a route to
 *              the wrong scope is visible in one glance rather than hidden in
 *              a URL allowlist.
 */

import fastifyCookie from "@fastify/cookie";
import { ProblemError } from "@polaris/shared-service-bootstrap";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { type AdminConfig, MINIMUM_PLATFORM_ROLE } from "./config.js";
import { createAdminGuard } from "./guard.js";
import { html, render } from "./html.js";
import { AdminIdentityCodec } from "./identity.js";
import type { IdpAuth } from "./idp-auth.js";
import {
  generateCodeVerifier,
  generateState,
  type IdpOAuthClient,
  IdpProxy,
  IdpProxyError,
} from "./idp-proxy.js";
import { type AdminPageContext, barePage, STYLESHEET } from "./layout.js";
import { verifySameOrigin } from "./origin.js";
import { renderAuditDetailPage, renderAuditPage } from "./pages/audit.js";
import {
  type LoginReason,
  renderForbiddenPage,
  renderLoginPage,
  renderOriginRefusedPage,
  renderSignedOutPage,
} from "./pages/auth.js";
import { renderDestinationDetailPage, renderDestinationsPage } from "./pages/destinations.js";
import { renderDlqDetailPage, renderDlqPage } from "./pages/dlq.js";
import { renderKeysPage } from "./pages/keys.js";
import { renderOverviewPage } from "./pages/overview.js";
import { renderProcessorsPage } from "./pages/processors.js";
import { renderProjectDetailPage, renderProjectsPage } from "./pages/projects.js";
import {
  type PlatformRoleName,
  platformRoleAtLeast,
  resolvePlatformRole,
} from "./platform-role.js";
import type { AdminQueries } from "./queries.js";
import {
  ADMIN_PREFIX,
  AUTH_PREFIX,
  clearFlowCookies,
  clearSessionCookies,
  readFlowCookies,
  readRefreshToken,
  setFlowCookies,
  setSessionCookies,
} from "./session.js";

export interface AdminPluginDeps {
  readonly config: AdminConfig;
  readonly queries: AdminQueries;
  readonly idpAuth: IdpAuth;
  /** Service environment, shown in the header chrome. */
  readonly environment: string;
  /** Test seam: drives the OAuth flow without a live Idp. */
  readonly idpClient?: IdpOAuthClient | undefined;
}

export function createAdminPlugin(deps: AdminPluginDeps): FastifyPluginAsync {
  const { config } = deps;
  const cookieOptions = { secure: config.cookieSecure };
  const identityCodec = new AdminIdentityCodec(config.sessionSecret);
  const idp: IdpOAuthClient = deps.idpClient ?? new IdpProxy(config.idp);

  return async function adminPlugin(app: FastifyInstance): Promise<void> {
    await app.register(fastifyCookie);

    // Forms only. Scoped, so `/v1/*` still refuses form-encoded bodies and
    // cannot be driven by a cross-site HTML form even in principle.
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err instanceof Error ? err : new Error("invalid form body"), undefined);
        }
      },
    );

    // HTML errors, not application/problem+json. A browser showing a JSON
    // problem document is a worse experience than a plain page, and the
    // parent scope's handler would do exactly that.
    app.setErrorHandler(async (error, request, reply) => {
      // A ProblemError raised by a parent-scope hook (notably the service-wide
      // bearer-auth hook, which 401s a malformed Authorization header before
      // this scope is reached) already carries the right status. Keep it —
      // reporting someone's bad credential as a 500 would send them hunting a
      // server fault that is not there.
      const status = error instanceof ProblemError ? error.status : 500;
      const detail =
        error instanceof ProblemError
          ? error.detail
          : "The panel could not render that page. The failure has been logged.";

      if (status >= 500) {
        request.log.error({ err: error }, "admin request failed");
      } else {
        request.log.warn({ err: error, status }, "admin request refused");
      }

      return reply
        .code(status)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          barePage(
            status >= 500 ? "Something went wrong" : "Request refused",
            html`<p class="notice error">${detail}</p>
              <p class="muted">Request ${request.id}</p>
              <p><a href="${ADMIN_PREFIX}">Back to Polaris</a></p>`,
          ),
        );
    });

    app.setNotFoundHandler(async (request, reply) => {
      return reply
        .code(404)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          barePage(
            "Not found",
            html`<p class="muted">No such page: ${request.url}</p>
              <p><a href="${ADMIN_PREFIX}">Back to Polaris</a></p>`,
          ),
        );
    });

    // ---- public scope: assets + the OAuth flow --------------------------
    await app.register(async (publicScope: FastifyInstance) => {
      publicScope.get("/assets/app.css", async (_request, reply) => {
        return reply
          .header("content-type", "text/css; charset=utf-8")
          .header("cache-control", "public, max-age=300")
          .send(render(STYLESHEET));
      });

      publicScope.get("/auth/login", async (request, reply) => {
        return sendHtml(
          reply,
          200,
          renderLoginPage({
            reason: loginReason(queryString(request, "reason")),
            next: safeNext(queryString(request, "next")),
          }),
        );
      });

      // Starts the OAuth round trip. A GET because it is a navigation, not a
      // state change worth protecting: the only thing it writes is a pair of
      // single-use flow cookies, and a forced login is not an attack.
      publicScope.get("/auth/start", async (request, reply) => {
        const state = generateState();
        const codeVerifier = generateCodeVerifier();
        const next = safeNext(queryString(request, "next"));
        setFlowCookies(
          reply,
          { state, codeVerifier, ...(next !== null ? { next } : {}) },
          cookieOptions,
        );
        return reply.redirect(idp.buildAuthorizeUrl(state, codeVerifier), 303);
      });

      publicScope.get("/auth/callback", async (request, reply) => {
        const code = queryString(request, "code");
        const state = queryString(request, "state");
        const error = queryString(request, "error");

        // Read before clearing. Both cookies are single-use and are cleared on
        // EVERY exit path below, so a half-finished flow cannot leave a
        // verifier in the browser waiting for the next code that turns up.
        const flow = readFlowCookies(request);
        clearFlowCookies(reply, cookieOptions);

        if (error.length > 0) {
          request.log.warn(
            { error, description: queryString(request, "error_description") },
            "idp returned an oauth error",
          );
          return redirectToLogin(reply, "idp_error");
        }
        if (code.length === 0 || state.length === 0) {
          return redirectToLogin(reply, "state_mismatch");
        }
        if (flow.state === undefined || state !== flow.state) {
          request.log.warn("oauth state mismatch");
          return redirectToLogin(reply, "state_mismatch");
        }
        // No verifier, no exchange. Sending the code without one would let Idp
        // redeem it — this client is confidential, so it would succeed — and
        // the binding PKCE exists to enforce would be silently absent on
        // exactly the flows where the cookie went missing.
        if (flow.codeVerifier === undefined) {
          request.log.warn("oauth callback with no pkce verifier; restarting the flow");
          return redirectToLogin(reply, "missing_verifier");
        }

        let tokens: Awaited<ReturnType<IdpOAuthClient["exchangeCode"]>>;
        try {
          tokens = await idp.exchangeCode(code, flow.codeVerifier);
        } catch (err) {
          const status = err instanceof IdpProxyError ? err.statusCode : 500;
          request.log.warn({ err, status }, "oauth code exchange failed");
          return redirectToLogin(reply, "exchange_failed");
        }

        // Verify and role-check BEFORE setting any cookie, so a denied
        // operator never holds a session at all.
        let role: PlatformRoleName;
        let subject: string;
        try {
          const passport = await deps.idpAuth.verifyAccessToken(tokens.access_token);
          role = resolvePlatformRole(passport);
          subject = passport.subject;
        } catch (err) {
          request.log.warn({ err }, "access token from idp failed verification");
          return redirectToLogin(reply, "invalid_token");
        }
        if (!platformRoleAtLeast(role, MINIMUM_PLATFORM_ROLE)) {
          request.log.warn(
            { event: "admin.login_denied", subject, platform_role: role },
            "login denied: platform_role below admin",
          );
          return sendHtml(reply, 403, renderForbiddenPage(role));
        }

        // Profile claims ride the ID token, never the access token
        // (idp ADR-0001). This is the only moment the email is available.
        let identityCookie: string | undefined;
        if (tokens.id_token !== undefined) {
          const claims = await deps.idpAuth.verifyIdToken(tokens.id_token);
          // The subject check matters: the identity cookie is what makes the
          // email trustworthy as an audit actor, so it must describe the same
          // person the access token does.
          if (claims !== null && claims.sub === subject) {
            identityCookie = identityCodec.encode({
              sub: claims.sub,
              email: claims.email,
              name: claims.name,
              idToken: tokens.id_token,
            });
          }
        }

        setSessionCookies(
          reply,
          {
            accessToken: tokens.access_token,
            expiresIn: tokens.expires_in,
            refreshToken: tokens.refresh_token,
            identity: identityCookie,
          },
          cookieOptions,
        );

        request.log.info({ event: "admin.login", subject, platform_role: role }, "admin signed in");
        // Re-validate on the way out: the cookie is same-site but the value
        // originally came from a query parameter.
        return reply.redirect(safeNext(flow.next ?? "") ?? ADMIN_PREFIX, 303);
      });

      publicScope.post("/auth/logout", async (request, reply) => {
        const verdict = verifySameOrigin(request);
        if (!verdict.ok) {
          request.log.warn({ reason: verdict.reason }, "admin logout refused: cross-origin");
          return sendHtml(reply, 403, renderOriginRefusedPage());
        }

        const identity = identityCodec.decode(request.cookies["polaris_admin_identity"]);
        const refreshToken = readRefreshToken(request);

        // Revoke first, clear second: if revocation throws, the operator is
        // still signed out locally rather than stuck in a half-state.
        if (refreshToken !== undefined) {
          try {
            await idp.revokeRefreshToken(refreshToken);
          } catch (err) {
            request.log.warn({ err }, "failed to revoke refresh token at idp");
          }
        }
        clearSessionCookies(reply, cookieOptions);

        // Without the end-session hop the browser's Idp session survives and
        // the next visit re-authenticates silently — which looks exactly like
        // logout not working.
        const postLogoutRedirectUri = `${request.protocol}://${request.host}${AUTH_PREFIX}/signed-out`;
        return reply.redirect(
          idp.buildEndSessionUrl({ postLogoutRedirectUri, idTokenHint: identity?.idToken ?? null }),
          303,
        );
      });

      publicScope.get("/auth/signed-out", async (_request, reply) => {
        return sendHtml(reply, 200, renderSignedOutPage());
      });
    });

    // ---- guarded scope: every page --------------------------------------
    await app.register(async (guarded: FastifyInstance) => {
      guarded.addHook(
        "preHandler",
        createAdminGuard({
          idpAuth: deps.idpAuth,
          identityCodec,
          renderForbidden: renderForbiddenPage,
        }),
      );

      const context = (request: FastifyRequest): AdminPageContext => {
        const admin = request.adminContext;
        return {
          environment: deps.environment,
          email: admin?.label ?? null,
          role: admin?.role ?? "none",
          requestId: String(request.id),
          path: request.url.split("?")[0] ?? request.url,
        };
      };

      guarded.get("/", async (request, reply) => {
        const [counts, recentAudit] = await Promise.all([
          deps.queries.counts(),
          deps.queries.listAudit({ limit: 10 }),
        ]);
        return sendHtml(
          reply,
          200,
          renderOverviewPage({ ctx: context(request), counts, recentAudit }),
        );
      });

      guarded.get("/projects", async (request, reply) => {
        const [projects, sources] = await Promise.all([
          deps.queries.listProjects(),
          deps.queries.listSources(),
        ]);
        return sendHtml(
          reply,
          200,
          renderProjectsPage({ ctx: context(request), projects, sources }),
        );
      });

      guarded.get<{ Params: { projectId: string } }>(
        "/projects/:projectId",
        async (request, reply) => {
          const projectId = request.params.projectId;
          const project = await deps.queries.findProject(projectId);
          if (project === null) return notFound(reply, `No project "${projectId}".`);

          const [sources, destinations, apiKeys] = await Promise.all([
            deps.queries.listSources(projectId),
            deps.queries.listDestinations({ projectId }),
            deps.queries.listApiKeys({ projectId, includeRevoked: false }),
          ]);
          return sendHtml(
            reply,
            200,
            renderProjectDetailPage({
              ctx: context(request),
              project,
              sources,
              destinations,
              apiKeys,
            }),
          );
        },
      );

      guarded.get("/destinations", async (request, reply) => {
        const filters = {
          project: queryString(request, "project"),
          environment: queryString(request, "environment"),
          status: queryString(request, "status"),
        };
        const destinations = await deps.queries.listDestinations({
          projectId: blankToUndefined(filters.project),
          environment: blankToUndefined(filters.environment),
          status: blankToUndefined(filters.status),
        });
        return sendHtml(
          reply,
          200,
          renderDestinationsPage({ ctx: context(request), destinations, filters }),
        );
      });

      guarded.get<{ Params: { destinationId: string } }>(
        "/destinations/:destinationId",
        async (request, reply) => {
          const destination = await deps.queries.findDestination(request.params.destinationId);
          if (destination === null) {
            return notFound(reply, `No destination "${request.params.destinationId}".`);
          }
          return sendHtml(
            reply,
            200,
            renderDestinationDetailPage({ ctx: context(request), destination }),
          );
        },
      );

      guarded.get("/keys", async (request, reply) => {
        const filters = {
          project: queryString(request, "project"),
          environment: queryString(request, "environment"),
          includeRevoked: queryString(request, "revoked").length > 0,
        };
        const keys = await deps.queries.listApiKeys({
          projectId: blankToUndefined(filters.project),
          environment: blankToUndefined(filters.environment),
          includeRevoked: filters.includeRevoked,
        });
        return sendHtml(reply, 200, renderKeysPage({ ctx: context(request), keys, filters }));
      });

      guarded.get("/processors", async (request, reply) => {
        const activations = await deps.queries.listProcessorActivations();
        return sendHtml(reply, 200, renderProcessorsPage({ ctx: context(request), activations }));
      });

      guarded.get("/dlq", async (request, reply) => {
        const filters = {
          destination: queryString(request, "destination"),
          vendor: queryString(request, "vendor"),
          includeResolved: queryString(request, "resolved").length > 0,
        };
        const records = await deps.queries.listDlq({
          destinationId: blankToUndefined(filters.destination),
          vendor: blankToUndefined(filters.vendor),
          includeResolved: filters.includeResolved,
          limit: config.pageSize,
        });
        return sendHtml(
          reply,
          200,
          renderDlqPage({ ctx: context(request), records, filters, limit: config.pageSize }),
        );
      });

      guarded.get<{ Params: { dlqId: string } }>("/dlq/:dlqId", async (request, reply) => {
        const record = await deps.queries.findDlq(request.params.dlqId);
        if (record === null) return notFound(reply, `No DLQ record "${request.params.dlqId}".`);
        return sendHtml(reply, 200, renderDlqDetailPage({ ctx: context(request), record }));
      });

      guarded.get("/audit", async (request, reply) => {
        const filters = {
          actor: queryString(request, "actor"),
          action: queryString(request, "action"),
          targetType: queryString(request, "target_type"),
          targetId: queryString(request, "target_id"),
          project: queryString(request, "project"),
          environment: queryString(request, "environment"),
        };
        const records = await deps.queries.listAudit({
          actorLabel: blankToUndefined(filters.actor),
          action: blankToUndefined(filters.action),
          targetType: blankToUndefined(filters.targetType),
          targetId: blankToUndefined(filters.targetId),
          projectId: blankToUndefined(filters.project),
          environment: blankToUndefined(filters.environment),
          limit: config.pageSize,
        });
        return sendHtml(
          reply,
          200,
          renderAuditPage({ ctx: context(request), records, filters, limit: config.pageSize }),
        );
      });

      guarded.get<{ Params: { auditId: string } }>("/audit/:auditId", async (request, reply) => {
        const record = await deps.queries.findAudit(request.params.auditId);
        if (record === null) return notFound(reply, `No audit record "${request.params.auditId}".`);
        return sendHtml(reply, 200, renderAuditDetailPage({ ctx: context(request), record }));
      });
    });
  };
}

// ---- helpers -------------------------------------------------------------

function sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply.code(status).header("content-type", "text/html; charset=utf-8").send(body);
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return sendHtml(
    reply,
    404,
    barePage(
      "Not found",
      html`<p class="muted">${message}</p>
        <p><a href="${ADMIN_PREFIX}">Back to Polaris</a></p>`,
    ),
  );
}

function redirectToLogin(reply: FastifyReply, reason: LoginReason): FastifyReply {
  return reply.redirect(`${AUTH_PREFIX}/login?reason=${reason}`, 303);
}

/** Read a query parameter as a string, collapsing arrays and absences to "". */
function queryString(request: FastifyRequest, name: string): string {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[name];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

function blankToUndefined(value: string): string | undefined {
  return value.length === 0 ? undefined : value;
}

const LOGIN_REASONS: ReadonlySet<string> = new Set<LoginReason>([
  "signed_out",
  "token_expired",
  "token_revoked",
  "invalid_token",
  "state_mismatch",
  "missing_verifier",
  "exchange_failed",
  "idp_error",
]);

function loginReason(value: string): LoginReason {
  return LOGIN_REASONS.has(value) ? (value as LoginReason) : "signed_out";
}

/**
 * Only same-origin admin paths survive as a post-login destination.
 *
 * An absolute URL or a protocol-relative `//evil.example` would turn the
 * callback into an open redirect, so anything that is not a plain `/admin/...`
 * path is dropped.
 */
function safeNext(value: string): string | null {
  if (!value.startsWith(ADMIN_PREFIX)) return null;
  if (value.startsWith("//")) return null;
  return value;
}
