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
import { MappingSemanticsError } from "@polaris/tenancy-control-plane";
import { MaskedSecretWriteError } from "@polaris/persistence-control-plane";
import type { PolarisEnvironment } from "@polaris/runtime-environments";
import { ProblemError } from "@polaris/runtime-service-bootstrap";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { v7 as uuidv7 } from "uuid";
import {
  checkMutation,
  describeRefusal,
  type MutationRefusal,
  requiredRoleFor,
} from "./actions/authorize.js";
import {
  type AdminActor,
  type AdminMutations,
  type MutationOutcome,
  MutationTargetMissing,
} from "./actions/mutations.js";
import { type AdminConfig, MINIMUM_PLATFORM_ROLE } from "./config.js";
import { createAdminGuard } from "./guard.js";
import { type Html, html, render } from "./html.js";
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
import {
  actionForm,
  actionsUnavailable,
  confirmAction,
  mutationResultNotice,
} from "./pages/actions.js";
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
import { renderKeyDetailPage, renderKeysPage } from "./pages/keys.js";
import { renderOverviewPage } from "./pages/overview.js";
import {
  ACTIVATION_ENVIRONMENTS,
  defaultProcessorFilters,
  parseProcessorTab,
  renderActivationDetailPage,
  renderProcessorsPage,
} from "./pages/processors.js";
import {
  declaredKeyFacts,
  needsConfirmation,
  parseConfigEnvironment,
  parseConfigFilter,
  parseConfigFormValue,
  parseWriteEnvironment,
  validateConfigName,
} from "./pages/project-config.js";
import {
  type ProjectTab,
  parseProjectTab,
  renderProjectDetailPage,
  renderProjectsPage,
} from "./pages/projects.js";
import {
  type PlatformRoleName,
  platformRoleAtLeast,
  resolvePlatformRole,
} from "./platform-role.js";
import type {
  AdminQueries,
  ApiKeyRow,
  DestinationRow,
  DlqRow,
  ProcessorActivationRow,
} from "./queries.js";
import { createSessionRefresher, type SessionRefresher } from "./refresh.js";
import {
  ADMIN_PREFIX,
  AUTH_PREFIX,
  clearFlowCookies,
  clearSessionCookies,
  readFlowCookies,
  readRefreshToken,
  setFlowCookies,
  setSessionCookies,
  signInPath,
} from "./session.js";
import { parseTheme, readTheme, setThemeCookie } from "./theme.js";

export interface AdminPluginDeps {
  readonly config: AdminConfig;
  readonly queries: AdminQueries;
  readonly idpAuth: IdpAuth;
  /** Service environment, shown in the header chrome. */
  readonly environment: string;
  /** Test seam: drives the OAuth flow without a live Idp. */
  readonly idpClient?: IdpOAuthClient | undefined;
  /** Test seam: redeems refresh tokens without a live Idp. */
  readonly refresher?: SessionRefresher | undefined;
  /**
   * Audited writes. Absent means the panel is read-only — every mutation
   * route 404s rather than existing and refusing, which is the same posture
   * the whole plugin takes when the UI is disabled.
   */
  readonly mutations?: AdminMutations | undefined;
}

export function createAdminPlugin(deps: AdminPluginDeps): FastifyPluginAsync {
  const { config } = deps;
  const cookieOptions = { secure: config.cookieSecure };
  const identityCodec = new AdminIdentityCodec(config.sessionSecret);
  const idp: IdpOAuthClient = deps.idpClient ?? new IdpProxy(config.idp);
  const refresher: SessionRefresher = deps.refresher ?? createSessionRefresher(config.idp);

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

      // Only reachable with a reason: a flow that failed, and a person who
      // needs to be told why. Everything else — a bookmark, the signed-out
      // page's link, an unrecognised reason — has nothing to say and no
      // choice to offer, so it goes straight through to Idp.
      publicScope.get("/auth/login", async (request, reply) => {
        const next = safeNext(queryString(request, "next"));
        const reason = loginReason(queryString(request, "reason"));
        if (reason === null) return reply.redirect(signInPath(next), 303);
        return sendHtml(reply, 200, renderLoginPage({ reason, next }));
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
          refresher,
          cookieOptions,
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
          // A theme change redirects here afterwards, so it has to be somewhere
          // a GET can land. Most pages are GETs and keep their query string —
          // filters survive the round trip. The rest are mutation POSTs that
          // re-render a detail page under an action URL (`…/keys/x/revoke`),
          // which has no GET handler; those fall back to the overview rather
          // than redirecting the operator into a 404.
          returnTo: request.method === "GET" ? request.url : ADMIN_PREFIX,
          theme: readTheme(request),
        };
      };

      /** Audit identity for a mutation, from the guard's resolved context. */
      const adminActor = (request: FastifyRequest): AdminActor => ({
        auditId: `polaris_aud_${uuidv7()}`,
        actorLabel: request.adminContext?.label ?? "unknown",
        requestId: String(request.id),
        occurredAt: new Date(),
      });

      /**
       * The slots a detail page fills from its mutation state: the button
       * beside the title, and anything that has to be said in prose above the
       * page. Shared by every page whose one action is a folded confirmation.
       */
      interface DetailActionSlots {
        readonly titleAction?: Html;
        readonly notice?: Html;
      }

      /**
       * Enable/disable buttons for a destination, or an explanation of why the
       * viewer cannot use them.
       *
       * Only the action that would actually change something is offered: a
       * disabled destination shows "enable" and nothing else, so the form
       * that would no-op is not there to be submitted. A `paused` row is
       * neither, and gets both.
       *
       * Each is a button that opens its own confirmation rather than a form
       * standing open — see `confirmAction`. The refusal, when there is one,
       * goes to the form it came from, which is what forces that one open.
       */
      const destinationActions = (
        request: FastifyRequest,
        destination: DestinationRow,
        options: {
          refusal?: MutationRefusal;
          previous?: { confirmation: string; reason: string };
          only?: "enable" | "disable";
        } = {},
      ): DetailActionSlots => {
        if (deps.mutations === undefined) return {};

        const role = request.adminContext?.role ?? "none";
        const required = requiredRoleFor(config, destination.environment);
        if (!platformRoleAtLeast(role, required)) {
          return {
            notice: actionsUnavailable({
              required,
              actual: role,
              environment: destination.environment,
            }),
          };
        }

        const base = `${ADMIN_PREFIX}/destinations/${encodeURIComponent(destination.destination_id)}`;
        const showDisable = destination.status !== "disabled" && options.only !== "enable";
        const showEnable = destination.status !== "active" && options.only !== "disable";
        if (!showDisable && !showEnable) return {};

        return {
          titleAction: html`${
            showDisable
              ? confirmAction({
                  action: `${base}/disable`,
                  submitLabel: "Disable destination",
                  expectedConfirmation: destination.instance_label,
                  description:
                    "Stops delivery to this destination. Events keep flowing through the pipeline and are not lost; they simply are not sent here until it is enabled again.",
                  environment: destination.environment,
                  danger: true,
                  ...(options.only === "disable" && options.refusal !== undefined
                    ? { refusal: options.refusal }
                    : {}),
                  ...(options.only === "disable" && options.previous !== undefined
                    ? { previous: options.previous }
                    : {}),
                })
              : null
          }
          ${
            showEnable
              ? confirmAction({
                  action: `${base}/enable`,
                  submitLabel: "Enable destination",
                  expectedConfirmation: destination.instance_label,
                  description:
                    "Resumes delivery to this destination and clears its disabled reason.",
                  environment: destination.environment,
                  danger: false,
                  ...(options.only === "enable" && options.refusal !== undefined
                    ? { refusal: options.refusal }
                    : {}),
                  ...(options.only === "enable" && options.previous !== undefined
                    ? { previous: options.previous }
                    : {}),
                })
              : null
          }`,
        };
      };

      /** Revoke form for an API key, or why the viewer cannot use it. */
      const keyActions = (
        request: FastifyRequest,
        key: ApiKeyRow,
        options: {
          refusal?: MutationRefusal;
          previous?: { confirmation: string; reason: string };
        } = {},
      ): Html | undefined => {
        if (deps.mutations === undefined) return undefined;
        if (key.status !== "active") {
          return html`<h2>Actions</h2>
            <p class="notice">This key is already revoked.</p>`;
        }

        const role = request.adminContext?.role ?? "none";
        const required = requiredRoleFor(config, key.environment);
        if (!platformRoleAtLeast(role, required)) {
          return html`<h2>Actions</h2>
            ${actionsUnavailable({ required, actual: role, environment: key.environment })}`;
        }

        return html`<h2>Actions</h2>
          ${actionForm({
            action: `${ADMIN_PREFIX}/keys/${encodeURIComponent(key.api_key_id)}/revoke`,
            submitLabel: "Revoke key",
            expectedConfirmation: key.source_id,
            description:
              "Revocation takes effect the moment it commits — there is no grace period, and any producer still using this key stops being able to ingest immediately. Issue its replacement first.",
            environment: key.environment,
            danger: true,
            ...(options.refusal !== undefined ? { refusal: options.refusal } : {}),
            ...(options.previous !== undefined ? { previous: options.previous } : {}),
          })}`;
      };

      /** Resolve one activation from its four-field key in the query string. */
      const findActivation = async (
        request: FastifyRequest,
      ): Promise<ProcessorActivationRow | null> => {
        const name = queryString(request, "name");
        const version = queryString(request, "version");
        const project = queryString(request, "project");
        const environment = queryString(request, "environment");
        if (name === "" || version === "" || project === "" || environment === "") return null;
        const all = await deps.queries.listProcessorActivations();
        return (
          all.find(
            (row) =>
              row.processor_name === name &&
              row.processor_version === version &&
              row.project_id === project &&
              row.environment === environment,
          ) ?? null
        );
      };

      /**
       * Enable/disable for an activation, or why the viewer cannot run it.
       *
       * The same folded button a destination gets: only one transition is ever
       * on offer here — the row is either enabled or disabled — so the button
       * beside the title names it, and the confirmation it demands stays
       * behind the fold until somebody asks for it.
       */
      const activationActions = (
        request: FastifyRequest,
        row: ProcessorActivationRow,
        options: {
          refusal?: MutationRefusal;
          previous?: { confirmation: string; reason: string };
        } = {},
      ): DetailActionSlots => {
        if (deps.mutations === undefined) return {};

        const role = request.adminContext?.role ?? "none";
        const required = requiredRoleFor(config, row.environment);
        if (!platformRoleAtLeast(role, required)) {
          return {
            notice: actionsUnavailable({ required, actual: role, environment: row.environment }),
          };
        }

        const enabling = row.enabled_state !== "enabled";
        const verb = enabling ? "enable" : "disable";
        return {
          titleAction: confirmAction({
            action: `${ADMIN_PREFIX}/processors/${verb}`,
            submitLabel: enabling ? "Enable processor" : "Disable processor",
            expectedConfirmation: row.processor_name,
            description: enabling
              ? "Resumes this processor for this project and environment. Its input stream keeps its checkpoint, so it picks up where it left off rather than dropping what accumulated."
              : "Stops this processor consuming for this project and environment. The input stream keeps retaining events, so nothing is lost — it simply falls behind until re-enabled.",
            environment: row.environment,
            danger: !enabling,
            // Four columns key an activation, so they ride in the body.
            hidden: {
              name: row.processor_name,
              version: row.processor_version,
              project: row.project_id,
              environment: row.environment,
            },
            ...(options.refusal !== undefined ? { refusal: options.refusal } : {}),
            ...(options.previous !== undefined ? { previous: options.previous } : {}),
          }),
        };
      };

      /** Mark-resolved form for a DLQ row, or why the viewer cannot use it. */
      const dlqActions = (
        request: FastifyRequest,
        row: DlqRow,
        options: {
          refusal?: MutationRefusal;
          previous?: { confirmation: string; reason: string };
        } = {},
      ): Html | undefined => {
        if (deps.mutations === undefined) return undefined;
        if (row.resolved_at !== null) {
          return html`<h2>Actions</h2>
            <p class="notice">This row is already resolved.</p>`;
        }

        const role = request.adminContext?.role ?? "none";
        const required = requiredRoleFor(config, row.environment);
        if (!platformRoleAtLeast(role, required)) {
          return html`<h2>Actions</h2>
            ${actionsUnavailable({ required, actual: role, environment: row.environment })}`;
        }

        return html`<h2>Mark resolved</h2>
          ${actionForm({
            action: `${ADMIN_PREFIX}/dlq/${encodeURIComponent(row.dlq_id)}/resolve`,
            submitLabel: "Mark resolved",
            expectedConfirmation: row.vendor,
            description:
              "Closes this row for triage. It does NOT redeliver anything — the event stays undelivered. Use this once you have decided the failure needs no retry, or have replayed it another way.",
            environment: row.environment,
            danger: false,
            ...(options.refusal !== undefined ? { refusal: options.refusal } : {}),
            ...(options.previous !== undefined ? { previous: options.previous } : {}),
          })}`;
      };

      /**
       * Light/dark/system, from the account menu.
       *
       * A POST rather than three links, for the same reason the other writes
       * here are: it is a state change, and the same-origin check that guards
       * every other form applies unchanged. It writes one display cookie and
       * nothing else — no audit record, because a palette is not an
       * operational fact anyone will need to reconstruct later.
       */
      guarded.post<{ Body: Record<string, unknown> }>(
        "/preferences/theme",
        async (request, reply) => {
          const origin = verifySameOrigin(request);
          if (!origin.ok) {
            request.log.warn({ reason: origin.reason }, "admin theme change refused: cross-origin");
            return sendHtml(reply, 403, renderOriginRefusedPage());
          }

          setThemeCookie(reply, parseTheme(formField(request, "theme")), cookieOptions);
          // Re-validated rather than trusted: the value was rendered by this
          // panel, but it arrives back as a form field like any other.
          return reply.redirect(safeNext(formField(request, "next")) ?? ADMIN_PREFIX, 303);
        },
      );

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

          const environment = parseConfigEnvironment(queryString(request, "env"));
          // All four run whatever tab is showing, because the tab strip states
          // how many rows are behind each one — that count is the whole reason
          // hiding three of the tables is not a loss of information. They are
          // small, indexed, single-project reads issued in parallel.
          const [sources, destinations, apiKeys, configRows] = await Promise.all([
            deps.queries.listSources(projectId),
            deps.queries.listDestinations({ projectId }),
            deps.queries.listApiKeys({ projectId, includeRevoked: false }),
            deps.queries.listProjectConfig({ projectId, environment }),
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
              config: {
                projectId,
                environment,
                rows: configRows,
                query: queryString(request, "q"),
                filter: parseConfigFilter(queryString(request, "filter")),
              },
              tab: requestedProjectTab(request),
            }),
          );
        },
      );

      /**
       * Project-configuration writes.
       *
       * All three delegate to `deps.mutations`, which calls the same
       * `*WithAudit` functions the polaris CLI uses — one transaction
       * carrying the value, the version bump, the pg_notify and the audit
       * row. The admin layer holds no SQL of its own.
       *
       * The two refusals that matter are raised inside that write path,
       * before any database access: a key resembling mapping semantics, and a
       * plaintext value on a secret-typed key. Both surface here as a
       * re-rendered page with the message, never a stack trace.
       */
      const configPage = async (
        request: FastifyRequest,
        projectId: string,
        environment: PolarisEnvironment,
        extra: {
          refusal?: MutationRefusal;
          refusalKey?: string;
          conflictKey?: string;
          error?: string;
        },
      ): Promise<string | null> => {
        const project = await deps.queries.findProject(projectId);
        if (project === null) return null;
        const [sources, destinations, apiKeys, configRows] = await Promise.all([
          deps.queries.listSources(projectId),
          deps.queries.listDestinations({ projectId }),
          deps.queries.listApiKeys({ projectId, includeRevoked: false }),
          deps.queries.listProjectConfig({ projectId, environment }),
        ]);
        return renderProjectDetailPage({
          ctx: context(request),
          project,
          sources,
          destinations,
          apiKeys,
          config: {
            projectId,
            environment,
            rows: configRows,
            ...(extra.refusal !== undefined ? { refusal: extra.refusal } : {}),
            ...(extra.refusalKey !== undefined ? { refusalKey: extra.refusalKey } : {}),
            ...(extra.conflictKey !== undefined ? { conflictKey: extra.conflictKey } : {}),
            ...(extra.error !== undefined ? { error: extra.error } : {}),
          },
          // Not `requestedProjectTab`: this is the response to a config POST,
          // which carries no query string at all. The refusal it is carrying
          // is rendered inside the Variables panel, so any other tab would
          // return a page that looks as though nothing happened.
          tab: "variables",
        });
      };

      const configWrite = (
        action: "set" | "unset" | "add",
      ): ((
        request: FastifyRequest<{
          Params: { projectId: string; environment: string };
          Body: Record<string, unknown>;
        }>,
        reply: FastifyReply,
      ) => Promise<unknown>) => {
        return async (request, reply) => {
          const origin = verifySameOrigin(request);
          if (!origin.ok) {
            request.log.warn({ reason: origin.reason }, "admin mutation refused: cross-origin");
            return sendHtml(reply, 403, renderOriginRefusedPage());
          }

          const projectId = request.params.projectId;
          const project = await deps.queries.findProject(projectId);
          if (project === null) return notFound(reply, `No project "${projectId}".`);

          // Writes never guess an environment. The GET tab falls back to
          // development because a tab is a display affordance; a POST with a
          // typoed environment must fail, not land the write somewhere else.
          const environment = parseWriteEnvironment(request.params.environment);
          if (environment === null) {
            return notFound(reply, `No environment "${request.params.environment}".`);
          }
          const namespace = formField(request, "namespace").trim();
          const key = formField(request, "key").trim();
          const rawReason = formField(request, "reason");
          const label = `${namespace}.${key}`;

          // `project_config` CHECK-constrains both names. Without this the
          // violation came back from Postgres as an unhandled error and the
          // operator got "Something went wrong" and a request id for what is
          // a typo in a form field. The CLI has always refused these with a
          // sentence; this is the same refusal on the same rules.
          const badName = validateConfigName(namespace, key);
          if (badName !== null) {
            request.log.warn(
              {
                event: "admin.mutation_refused",
                action: `config.${action}`,
                target: `${projectId}/${environment}/${label}`,
                refusal: "name_format",
              },
              badName,
            );
            const body = await configPage(request, projectId, environment, { error: badName });
            if (body === null) return notFound(reply, `No project "${projectId}".`);
            return sendHtml(reply, 400, body);
          }

          // The stored row and the schema's view of the key, fetched BEFORE
          // the gate: whether the ritual applies is the SERVER's decision. An
          // earlier revision treated an absent confirm field as "ritual
          // satisfied", which meant a stripped form or a curl bypassed the
          // typed confirmation on exactly the two shapes it exists for.
          const current = await deps.queries.listProjectConfig({ projectId, environment });
          const existing = current.find(
            (row) => row.namespace === namespace && row.config_key === key,
          );
          const facts = declaredKeyFacts(namespace, key);
          // A key the schema marks secret is secret regardless of what the
          // form says, and a stored secret row stays one. Without this, a
          // write omitting the flag would store a live credential as a plain
          // value — visible in every list view and copied into the audit row.
          // Plan §3.5 assigns this check to the admin API.
          const isSecret =
            facts.secret || existing?.is_secret === true || formField(request, "secret") === "true";
          const ritualRequired = needsConfirmation({
            action: action === "unset" ? "unset" : "set",
            environment,
            secret: isSecret,
            required: facts.required,
          });

          const typed = formField(request, "confirm");
          const check = checkMutation(config, {
            rowEnvironment: environment,
            role: request.adminContext?.role ?? "none",
            // When the ritual applies the operator's typing must match; when
            // it does not, the label satisfies itself so one code path still
            // enforces the role gate for both form shapes.
            confirmation: ritualRequired ? typed : label,
            expectedConfirmation: label,
            // The reason belongs to the ritual, not to every write. A routine
            // value edit has no reason box to fill, so demanding one here
            // would refuse a form that is behaving correctly. The role gate
            // and the audit row are unchanged either way, and
            // `audit_records.reason` is nullable for exactly this.
            reason: ritualRequired ? rawReason : null,
          });

          if (!check.ok) {
            request.log.warn(
              {
                event: "admin.mutation_refused",
                action: `config.${action}`,
                target: `${projectId}/${environment}/${label}`,
                refusal: check.refusal.kind,
              },
              describeRefusal(check.refusal),
            );
            const body = await configPage(request, projectId, environment, {
              refusal: check.refusal,
              refusalKey: label,
            });
            if (body === null) return notFound(reply, `No project "${projectId}".`);
            return sendHtml(reply, check.refusal.kind === "role" ? 403 : 400, body);
          }

          const mutations = deps.mutations;
          if (mutations === undefined) {
            // Same posture as every other write here: a panel built without a
            // mutations facade is read-only, and a POST that reaches it is a
            // wiring error rather than an operator one.
            return notFound(reply, "This admin panel is read-only.");
          }

          const actor = adminActor(request);
          try {
            if (action === "unset") {
              await mutations.unsetProjectConfig(
                { projectId, environment, namespace, configKey: key },
                check.reason,
                actor,
              );
            } else {
              const raw = formField(request, "value");
              // "Declare" means declare: colliding with an existing key would
              // be a stealth overwrite that bypasses the compare-and-set the
              // edit forms carry. Point the operator at the edit row instead.
              if (action === "add" && existing !== undefined) {
                const body = await configPage(request, projectId, environment, {
                  error: `${label} already exists — edit it in the table above rather than re-declaring it.`,
                });
                if (body === null) return notFound(reply, `No project "${projectId}".`);
                return sendHtml(reply, 409, body);
              }
              // Compare-and-set: the form carries the row's updated_at as it
              // was rendered; a mismatch means another operator wrote first.
              // Read-then-write, not transactional — it guards the human case
              // (a stale page held open), not a sub-millisecond race, which
              // last-write-wins-with-audit is an acceptable answer to.
              const expected = formField(request, "expected_updated_at");
              if (action === "set" && (existing?.updated_at ?? "") !== expected) {
                const body = await configPage(request, projectId, environment, {
                  conflictKey: label,
                });
                if (body === null) return notFound(reply, `No project "${projectId}".`);
                return sendHtml(reply, 409, body);
              }
              await mutations.setProjectConfig(
                {
                  projectId,
                  environment,
                  namespace,
                  configKey: key,
                  value: parseConfigFormValue(raw, isSecret),
                  isSecret,
                },
                check.reason,
                actor,
              );
            }
          } catch (err) {
            // The write path's own gates. An operator mistake, not a fault:
            // re-render with the message rather than a 500.
            // A CHECK violation that reaches here is still an operator
            // mistake — the panel simply has no bespoke message for that
            // constraint yet. Naming the constraint beats a 500: it says
            // which rule was broken, and it is greppable in the migrations.
            const constraint = checkViolation(err);
            if (constraint !== null) {
              request.log.warn(
                { event: "admin.mutation_refused", action: `config.${action}`, err },
                "project-config write violated a database constraint",
              );
              const body = await configPage(request, projectId, environment, {
                error: `The database refused this write: ${constraint}. The value or one of its names does not satisfy that rule.`,
              });
              if (body === null) return notFound(reply, `No project "${projectId}".`);
              return sendHtml(reply, 400, body);
            }
            if (err instanceof MappingSemanticsError || err instanceof MaskedSecretWriteError) {
              const message = err.message;
              request.log.warn(
                { event: "admin.mutation_refused", action: `config.${action}`, err },
                "project-config write refused",
              );
              const body = await configPage(request, projectId, environment, {
                error: message,
              });
              if (body === null) return notFound(reply, `No project "${projectId}".`);
              return sendHtml(reply, 400, body);
            }
            throw err;
          }

          request.log.info(
            {
              event: "admin.mutation",
              action: `config.${action}`,
              target: `${projectId}/${environment}/${label}`,
              environment,
              actor: actor.actorLabel,
            },
            "admin mutation applied",
          );

          return reply.redirect(
            `${ADMIN_PREFIX}/projects/${encodeURIComponent(projectId)}?tab=variables&env=${environment}`,
            303,
          );
        };
      };

      guarded.post<{
        Params: { projectId: string; environment: string };
        Body: Record<string, unknown>;
      }>("/projects/:projectId/config/:environment/set", configWrite("set"));

      guarded.post<{
        Params: { projectId: string; environment: string };
        Body: Record<string, unknown>;
      }>("/projects/:projectId/config/:environment/unset", configWrite("unset"));

      guarded.post<{
        Params: { projectId: string; environment: string };
        Body: Record<string, unknown>;
      }>("/projects/:projectId/config/:environment/add", configWrite("add"));

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
            renderDestinationDetailPage({
              ctx: context(request),
              destination,
              ...destinationActions(request, destination),
            }),
          );
        },
      );

      // ---- mutations ----------------------------------------------------
      // Registered only when a mutations implementation is wired, so a
      // read-only deployment does not carry routes that exist to refuse.
      if (deps.mutations !== undefined) {
        const mutations = deps.mutations;

        guarded.post<{ Params: { apiKeyId: string }; Body: Record<string, unknown> }>(
          "/keys/:apiKeyId/revoke",
          async (request, reply) => {
            const origin = verifySameOrigin(request);
            if (!origin.ok) {
              request.log.warn({ reason: origin.reason }, "admin mutation refused: cross-origin");
              return sendHtml(reply, 403, renderOriginRefusedPage());
            }

            const key = await deps.queries.findApiKey(request.params.apiKeyId);
            if (key === null) return notFound(reply, `No API key "${request.params.apiKeyId}".`);

            const confirmation = formField(request, "confirm");
            const rawReason = formField(request, "reason");
            const check = checkMutation(config, {
              rowEnvironment: key.environment,
              role: request.adminContext?.role ?? "none",
              confirmation,
              // The source id, not the polaris_ak_ identifier: the operator
              // should be reading which producer they are about to break.
              expectedConfirmation: key.source_id,
              reason: rawReason,
            });

            if (!check.ok) {
              request.log.warn(
                {
                  event: "admin.mutation_refused",
                  action: "keys.revoke",
                  target: key.api_key_id,
                  refusal: check.refusal.kind,
                },
                describeRefusal(check.refusal),
              );
              return sendHtml(
                reply,
                check.refusal.kind === "role" ? 403 : 400,
                renderKeyDetailPage({
                  ctx: context(request),
                  apiKey: key,
                  actions: keyActions(request, key, {
                    refusal: check.refusal,
                    previous: { confirmation, reason: rawReason },
                  }),
                }),
              );
            }

            const actor = adminActor(request);
            let outcome: MutationOutcome;
            try {
              outcome = await mutations.revokeApiKey(key.api_key_id, check.reason, actor);
            } catch (err) {
              if (err instanceof MutationTargetMissing) {
                return notFound(reply, `No API key "${request.params.apiKeyId}".`);
              }
              throw err;
            }

            request.log.info(
              {
                event: "admin.mutation",
                action: "keys.revoke",
                target: key.api_key_id,
                environment: key.environment,
                applied: outcome.applied,
                audit_id: outcome.auditId,
                actor: actor.actorLabel,
              },
              "admin mutation applied",
            );

            const fresh = (await deps.queries.findApiKey(key.api_key_id)) ?? key;
            return sendHtml(
              reply,
              200,
              renderKeyDetailPage({
                ctx: context(request),
                apiKey: fresh,
                actions: html`${mutationResultNotice({
                  applied: outcome.applied,
                  appliedText: "Key revoked. It can no longer authenticate ingest.",
                  noopText: "Already revoked — nothing changed, and no audit record was written.",
                  auditId: outcome.auditId,
                })}${keyActions(request, fresh)}`,
              }),
            );
          },
        );

        guarded.post<{ Params: { dlqId: string }; Body: Record<string, unknown> }>(
          "/dlq/:dlqId/resolve",
          async (request, reply) => {
            const origin = verifySameOrigin(request);
            if (!origin.ok) {
              request.log.warn({ reason: origin.reason }, "admin mutation refused: cross-origin");
              return sendHtml(reply, 403, renderOriginRefusedPage());
            }

            const record = await deps.queries.findDlq(request.params.dlqId);
            if (record === null) {
              return notFound(reply, `No DLQ record "${request.params.dlqId}".`);
            }

            const confirmation = formField(request, "confirm");
            const rawReason = formField(request, "reason");
            const check = checkMutation(config, {
              rowEnvironment: record.environment,
              role: request.adminContext?.role ?? "none",
              confirmation,
              expectedConfirmation: record.vendor,
              reason: rawReason,
            });

            if (!check.ok) {
              request.log.warn(
                {
                  event: "admin.mutation_refused",
                  action: "dlq.mark_resolved",
                  target: record.dlq_id,
                  refusal: check.refusal.kind,
                },
                describeRefusal(check.refusal),
              );
              return sendHtml(
                reply,
                check.refusal.kind === "role" ? 403 : 400,
                renderDlqDetailPage({
                  ctx: context(request),
                  record,
                  actions: dlqActions(request, record, {
                    refusal: check.refusal,
                    previous: { confirmation, reason: rawReason },
                  }),
                }),
              );
            }

            const actor = adminActor(request);
            const outcome = await mutations.markDlqResolved(
              {
                dlqId: record.dlq_id,
                projectId: record.project_id,
                environment: record.environment,
                vendor: record.vendor,
                reason: record.reason,
              },
              check.reason,
              actor,
            );

            request.log.info(
              {
                event: "admin.mutation",
                action: "dlq.mark_resolved",
                target: record.dlq_id,
                environment: record.environment,
                applied: outcome.applied,
                audit_id: outcome.auditId,
                actor: actor.actorLabel,
              },
              "admin mutation applied",
            );

            const fresh = (await deps.queries.findDlq(record.dlq_id)) ?? record;
            return sendHtml(
              reply,
              200,
              renderDlqDetailPage({
                ctx: context(request),
                record: fresh,
                actions: html`${mutationResultNotice({
                  applied: outcome.applied,
                  appliedText: "DLQ row marked resolved. Nothing was redelivered.",
                  noopText: "Already resolved — nothing changed, and no audit record was written.",
                  auditId: outcome.auditId,
                })}${dlqActions(request, fresh)}`,
              }),
            );
          },
        );

        for (const verb of ["enable", "disable"] as const) {
          guarded.post<{ Body: Record<string, unknown> }>(
            `/processors/${verb}`,
            async (request, reply) => {
              const origin = verifySameOrigin(request);
              if (!origin.ok) {
                request.log.warn({ reason: origin.reason }, "admin mutation refused: cross-origin");
                return sendHtml(reply, 403, renderOriginRefusedPage());
              }

              const key = {
                processor_name: formField(request, "name"),
                processor_version: formField(request, "version"),
                project_id: formField(request, "project"),
                environment: formField(request, "environment"),
              };
              const all = await deps.queries.listProcessorActivations();
              const row = all.find(
                (candidate) =>
                  candidate.processor_name === key.processor_name &&
                  candidate.processor_version === key.processor_version &&
                  candidate.project_id === key.project_id &&
                  candidate.environment === key.environment,
              );
              if (row === undefined) {
                return notFound(reply, `No processor activation for ${key.processor_name}.`);
              }

              const confirmation = formField(request, "confirm");
              const rawReason = formField(request, "reason");
              const check = checkMutation(config, {
                rowEnvironment: row.environment,
                role: request.adminContext?.role ?? "none",
                confirmation,
                expectedConfirmation: row.processor_name,
                reason: rawReason,
              });

              if (!check.ok) {
                request.log.warn(
                  {
                    event: "admin.mutation_refused",
                    action: `processors.${verb}`,
                    target: row.processor_name,
                    refusal: check.refusal.kind,
                  },
                  describeRefusal(check.refusal),
                );
                return sendHtml(
                  reply,
                  check.refusal.kind === "role" ? 403 : 400,
                  renderActivationDetailPage({
                    ctx: context(request),
                    activation: row,
                    ...activationActions(request, row, {
                      refusal: check.refusal,
                      previous: { confirmation, reason: rawReason },
                    }),
                  }),
                );
              }

              const actor = adminActor(request);
              const outcome =
                verb === "enable"
                  ? await mutations.enableProcessor(key, check.reason, actor)
                  : await mutations.disableProcessor(key, check.reason, actor);

              request.log.info(
                {
                  event: "admin.mutation",
                  action: `processors.${verb}`,
                  target: row.processor_name,
                  environment: row.environment,
                  applied: outcome.applied,
                  audit_id: outcome.auditId,
                  actor: actor.actorLabel,
                },
                "admin mutation applied",
              );

              const refreshed = await deps.queries.listProcessorActivations();
              const fresh =
                refreshed.find(
                  (candidate) =>
                    candidate.processor_name === key.processor_name &&
                    candidate.processor_version === key.processor_version &&
                    candidate.project_id === key.project_id &&
                    candidate.environment === key.environment,
                ) ?? row;

              const slots = activationActions(request, fresh);
              return sendHtml(
                reply,
                200,
                renderActivationDetailPage({
                  ctx: context(request),
                  activation: fresh,
                  ...slots,
                  // The result leads; anything the slots had to say about what
                  // may be done next follows it.
                  notice: html`${mutationResultNotice({
                    applied: outcome.applied,
                    appliedText:
                      verb === "enable"
                        ? "Processor enabled for this project and environment."
                        : "Processor disabled for this project and environment.",
                    noopText:
                      "Already in that state — nothing changed, and no audit record was written.",
                    auditId: outcome.auditId,
                  })}${slots.notice ?? null}`,
                }),
              );
            },
          );
        }

        for (const verb of ["disable", "enable"] as const) {
          guarded.post<{
            Params: { destinationId: string };
            Body: Record<string, unknown>;
          }>(`/destinations/:destinationId/${verb}`, async (request, reply) => {
            const origin = verifySameOrigin(request);
            if (!origin.ok) {
              request.log.warn({ reason: origin.reason }, "admin mutation refused: cross-origin");
              return sendHtml(reply, 403, renderOriginRefusedPage());
            }

            const destination = await deps.queries.findDestination(request.params.destinationId);
            if (destination === null) {
              return notFound(reply, `No destination "${request.params.destinationId}".`);
            }

            const confirmation = formField(request, "confirm");
            const rawReason = formField(request, "reason");

            // Gate on the ROW's environment, resolved above — a preHandler
            // would have had to run before the row was known, which is the
            // hole the service-wide gate falls into. See actions/authorize.ts.
            const check = checkMutation(config, {
              rowEnvironment: destination.environment,
              role: request.adminContext?.role ?? "none",
              confirmation,
              expectedConfirmation: destination.instance_label,
              reason: rawReason,
            });

            if (!check.ok) {
              request.log.warn(
                {
                  event: "admin.mutation_refused",
                  action: `destinations.${verb}`,
                  target: destination.destination_id,
                  refusal: check.refusal.kind,
                },
                describeRefusal(check.refusal),
              );
              return sendHtml(
                reply,
                check.refusal.kind === "role" ? 403 : 400,
                renderDestinationDetailPage({
                  ctx: context(request),
                  destination,
                  ...destinationActions(request, destination, {
                    refusal: check.refusal,
                    previous: { confirmation, reason: rawReason },
                    only: verb,
                  }),
                }),
              );
            }

            const actor = adminActor(request);
            let outcome: MutationOutcome;
            try {
              outcome =
                verb === "disable"
                  ? await mutations.disableDestination(
                      destination.destination_id,
                      check.reason,
                      actor,
                    )
                  : await mutations.enableDestination(
                      destination.destination_id,
                      check.reason,
                      actor,
                    );
            } catch (err) {
              if (err instanceof MutationTargetMissing) {
                return notFound(reply, `No destination "${request.params.destinationId}".`);
              }
              throw err;
            }

            request.log.info(
              {
                event: "admin.mutation",
                action: `destinations.${verb}`,
                target: destination.destination_id,
                environment: destination.environment,
                applied: outcome.applied,
                audit_id: outcome.auditId,
                actor: actor.actorLabel,
              },
              "admin mutation applied",
            );

            const fresh =
              (await deps.queries.findDestination(destination.destination_id)) ?? destination;
            const slots = destinationActions(request, fresh);
            return sendHtml(
              reply,
              200,
              renderDestinationDetailPage({
                ctx: context(request),
                destination: fresh,
                ...slots,
                // The result leads; anything the slots had to say about what
                // may be done next follows it.
                notice: html`${mutationResultNotice({
                  applied: outcome.applied,
                  appliedText:
                    verb === "disable"
                      ? `Destination disabled. Delivery has stopped.`
                      : `Destination enabled. Delivery has resumed.`,
                  noopText:
                    verb === "disable"
                      ? `Already disabled — nothing changed, and no audit record was written.`
                      : `Already active — nothing changed, and no audit record was written.`,
                  auditId: outcome.auditId,
                })}${slots.notice ?? null}`,
              }),
            );
          });
        }
      }

      guarded.get<{ Params: { apiKeyId: string } }>("/keys/:apiKeyId", async (request, reply) => {
        const key = await deps.queries.findApiKey(request.params.apiKeyId);
        if (key === null) return notFound(reply, `No API key "${request.params.apiKeyId}".`);
        return sendHtml(
          reply,
          200,
          renderKeyDetailPage({
            ctx: context(request),
            apiKey: key,
            actions: keyActions(request, key),
          }),
        );
      });

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

      guarded.get("/processors/activation", async (request, reply) => {
        // A combination with no row is RUNNING (the gate only closes on an
        // explicit `disabled` row), so 404ing here made exactly the
        // combinations an operator most needs to act on unreachable: the
        // ones nobody has decided about. Synthesize the implicit state
        // instead, so the enable/disable form is available for every
        // combination the matrix lists. The mutations upsert, so acting on
        // a synthesized row creates the real one.
        const activation = (await findActivation(request)) ?? synthesizeActivation(request);
        if (activation === null) return notFound(reply, "No such processor activation.");
        return sendHtml(
          reply,
          200,
          renderActivationDetailPage({
            ctx: context(request),
            activation,
            ...activationActions(request, activation),
          }),
        );
      });

      guarded.get("/processors", async (request, reply) => {
        // Projects join the query so the page can show every
        // (processor, version, project, environment) combination rather
        // than only the ones somebody already decided about. A combination
        // with no row is running, and that is precisely what an operator
        // must not have to infer.
        const [activations, runs, projects] = await Promise.all([
          deps.queries.listProcessorActivations(),
          deps.queries.listProcessorRuns(config.pageSize),
          deps.queries.listProjects(),
        ]);
        // Defaults are for an operator who has not filtered anything, so a
        // single filter parameter — even an empty one — switches them off
        // entirely. Empty is how a submitted form says "any", and honouring
        // a default over it would make a select the operator just cleared
        // spring back. Per-key defaults would do exactly that.
        const projectIds = projects.map((p) => p.project_id);
        const defaulted = !PROCESSOR_FILTER_KEYS.some((key) => hasQueryKey(request, key));
        const filters = defaulted
          ? defaultProcessorFilters({
              projects: projectIds,
              serviceEnvironment: deps.environment,
            })
          : {
              // `name` rather than `processor`, so the filter shares its
              // parameter with the activation-detail link the table's own
              // rows already build — clicking through and coming back keeps
              // the filter instead of quietly widening it.
              processor: queryString(request, "name"),
              project: queryString(request, "project"),
              environment: queryString(request, "environment"),
              state: queryString(request, "state"),
              status: queryString(request, "status"),
            };

        return sendHtml(
          reply,
          200,
          renderProcessorsPage({
            ctx: context(request),
            activations,
            runs,
            projects: projectIds,
            environments: ACTIVATION_ENVIRONMENTS,
            filters,
            tab: parseProcessorTab(queryString(request, "tab")),
            defaulted,
          }),
        );
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
        return sendHtml(
          reply,
          200,
          renderDlqDetailPage({
            ctx: context(request),
            record,
            actions: dlqActions(request, record),
          }),
        );
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

/** Read a urlencoded form field as a string. */
function formField(request: FastifyRequest, name: string): string {
  const body = request.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === "string" ? value : "";
}

function blankToUndefined(value: string): string | undefined {
  return value.length === 0 ? undefined : value;
}

const LOGIN_REASONS: ReadonlySet<string> = new Set<LoginReason>([
  "invalid_token",
  "state_mismatch",
  "missing_verifier",
  "exchange_failed",
  "idp_error",
]);

/** `null` for anything unrecognised: no failure to report, so no page. */
function loginReason(value: string): LoginReason | null {
  return LOGIN_REASONS.has(value) ? (value as LoginReason) : null;
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

/**
 * The name of the CHECK constraint a write violated, or null.
 *
 * `23514` is Postgres' check_violation SQLSTATE. Read structurally rather
 * than by matching the message text, which is localised and version-dependent.
 */
function checkViolation(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const candidate = err as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23514") return null;
  return typeof candidate.constraint === "string" ? candidate.constraint : "a check constraint";
}

/** The query parameters that mean "the operator has chosen a view". */
const PROCESSOR_FILTER_KEYS = ["name", "project", "environment", "state", "status"] as const;

/**
 * Whether a query parameter was SENT, as opposed to sent empty.
 *
 * `queryString` cannot tell the two apart — both come back "" — and here the
 * difference is the whole mechanism: `?state=` is an operator who cleared the
 * state filter, while no `state` at all is an operator who has not touched
 * it. Only the second gets a default.
 */
function hasQueryKey(request: FastifyRequest, name: string): boolean {
  const query = request.query as Record<string, unknown> | undefined;
  return query !== undefined && Object.hasOwn(query, name);
}

/**
 * Which tab of a project page to render.
 *
 * `?env=` with no `?tab=` means Variables. That combination is not
 * hypothetical: it is what the config write path redirects to, and what every
 * link written before the page had tabs looks like. Landing it on the
 * overview would show the operator a page with no sign of the change they
 * just made.
 */
function requestedProjectTab(request: FastifyRequest): ProjectTab {
  const tab = queryString(request, "tab");
  if (tab.length > 0) return parseProjectTab(tab);
  return queryString(request, "env").length > 0 ? "variables" : "overview";
}

/**
 * Build the implicit activation for a combination that has no row.
 *
 * `enabled_state: "enabled"` because that is what the runtime does — the
 * gate lets an event through unless an explicit `disabled` row says
 * otherwise. The null timestamps and the `(default)` author are what
 * distinguish it from a decision somebody actually made.
 *
 * Returns null when the four-field key is incomplete, which is the one
 * case that really is a bad URL rather than an undecided combination.
 */
function synthesizeActivation(request: FastifyRequest): ProcessorActivationRow | null {
  const processor_name = queryString(request, "name");
  const processor_version = queryString(request, "version");
  const project_id = queryString(request, "project");
  const environment = queryString(request, "environment");
  if (
    processor_name === "" ||
    processor_version === "" ||
    project_id === "" ||
    environment === ""
  ) {
    return null;
  }
  return {
    processor_name,
    processor_version,
    project_id,
    environment,
    enabled_state: "enabled",
    enabled_at: null,
    disabled_at: null,
    last_changed_by: "(default — no activation row)",
  };
}
