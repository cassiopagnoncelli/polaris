/**
 * Admin UI integration tests.
 *
 * Driven through `app.inject()` against a fully built app, with three things
 * stubbed so no live Idp, signing key, or Postgres is needed:
 * `adminQueries`, `idpAuth`, and `idpClient`.
 *
 * Passports are constructed directly rather than signed — `@polaris/idp`'s
 * own `contract.test.ts` covers real signature verification, so re-doing it
 * here would test jose twice and the guard's logic once.
 *
 * The isolation group is the important one. It proves the admin plugin's
 * cookie parser, form parser, HTML error handlers, and session guard stay
 * inside the `/admin` scope. If Fastify's encapsulation assumptions ever
 * change, those cases fail loudly instead of the JSON API quietly growing a
 * cookie-authenticated path.
 */

import { Passport, PLATFORM_ROLE_CLAIM, type PlatformRole } from "@polaris/idp";
import { describe, expect, it, vi } from "vitest";
import type { AdminConfig } from "../src/admin/config.js";
import { AdminIdentityCodec } from "../src/admin/identity.js";
import type { IdpAuth } from "../src/admin/idp-auth.js";
import { IdpAuthError } from "../src/admin/idp-auth.js";
import type { IdpOAuthClient, IdpTokenResponse } from "../src/admin/idp-proxy.js";
import type { AdminQueries } from "../src/admin/queries.js";
import type { SessionRefresher } from "../src/admin/refresh.js";
import { buildControlPlaneApp } from "../src/app.js";
import type { ControlPlaneConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_SECRET = "s".repeat(48);
const ISSUER = "http://localhost:3011";
const SUBJECT = "usr_0196000000000000";
const EMAIL = "ops@example.com";

/** A hash value that must never appear in a rendered page. */
const SECRET_HASH = "$argon2id$v=19$m=65536,t=3,p=4$NEVER$RENDER-THIS-HASH";

function makeAdminConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    enabled: true,
    cookieSecure: false,
    sessionSecret: SESSION_SECRET,
    pageSize: 50,
    productionMinRole: "owner",
    idp: {
      baseUrl: ISSUER,
      issuer: ISSUER,
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
      clientId: "polaris_test",
      clientSecret: "polaris_test_secret",
      redirectUri: "http://localhost:4001/admin/auth/callback",
      endSessionEndpoint: `${ISSUER}/oauth/end_session`,
      tokenUrl: `${ISSUER}/oauth/token`,
      revokeUrl: `${ISSUER}/oauth/revoke`,
      authorizeUrl: `${ISSUER}/oauth/authorize`,
      requestTimeoutMs: 10_000,
    },
    ...overrides,
  };
}

function makeConfig(admin: AdminConfig | null): ControlPlaneConfig {
  return {
    service: {
      serviceName: "control-plane-api",
      serviceVersion: "0.0.1",
      environment: "local",
      logLevel: "fatal",
      logPretty: false,
      gitSha: "deadbee",
      buildTime: "2026-05-14T10:00:00.000Z",
      releaseLabel: undefined,
    },
    http: {
      host: "127.0.0.1",
      port: 0,
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
    },
    postgres: {
      host: "localhost",
      port: 5432,
      database: "polaris",
      user: "polaris",
      password: "polaris",
      ssl: false,
      poolMax: 10,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
    },
    admin,
  };
}

function passportFor(role: PlatformRole | null, overrides: Record<string, unknown> = {}): Passport {
  return new Passport({
    iss: ISSUER,
    sub: SUBJECT,
    aud: ISSUER,
    iat: 0,
    exp: 9_999_999_999,
    jti: "tok_1",
    sid: "ses_1",
    amr: ["pwd"],
    acr: "aal1",
    ...(role !== null ? { [PLATFORM_ROLE_CLAIM]: role } : {}),
    ...overrides,
  } as never);
}

/** Fixture tokens, one per role plus the failure cases. */
const TOKENS: Readonly<Record<string, Passport>> = {
  "owner-token": passportFor("owner"),
  "admin-token": passportFor("admin"),
  "member-token": passportFor("member"),
  "viewer-token": passportFor("viewer"),
  "none-token": passportFor("none"),
  "null-role-token": passportFor(null),
  // sub === client_id: a client-credentials token. Reading platformRole on
  // this throws, which is exactly what the guard must not do.
  "service-token": passportFor("owner", { sub: "svc_client", client_id: "svc_client" }),
};

function makeIdpAuth(overrides: Partial<IdpAuth> = {}): IdpAuth {
  return {
    verifyAccessToken: async (token: string) => {
      const passport = TOKENS[token];
      if (passport === undefined) {
        throw new IdpAuthError("Invalid access token", "invalid_token");
      }
      return passport;
    },
    verifyIdToken: async () => ({ sub: SUBJECT, email: EMAIL, name: "Ops Person" }),
    ...overrides,
  };
}

function makeQueries(overrides: Partial<AdminQueries> = {}): AdminQueries {
  const project = {
    project_id: "storefront",
    display_name: "Storefront",
    owner: "growth",
    description: "Retail web",
    status: "active",
    created_at: new Date("2026-01-01T00:00:00Z"),
  };
  return {
    counts: async () => ({
      projects: 1,
      sources: 2,
      destinationsActive: 1,
      destinationsInactive: 0,
      apiKeysActive: 1,
      dlqUnresolved: 0,
    }),
    listProjects: async () => [project],
    findProject: async (id) => (id === project.project_id ? project : null),
    listSources: async () => [
      {
        project_id: "storefront",
        source_id: "storefront-web",
        source_type: "web",
        owner: "growth",
        runtime: "active",
        status: "active",
        allowed_environments: ["development", "production"],
      },
    ],
    listDestinations: async () => [
      {
        destination_id: "polaris_dst_1",
        project_id: "storefront",
        environment: "production",
        vendor: "ga4",
        instance_label: "storefront-prod",
        secret_ref: "env:GA4_TOKEN",
        status: "active",
        mode: "live",
        max_concurrency: 4,
        max_rps: 50,
        retry_policy: "standard",
        dead_letter_threshold: 5,
        // A stored-XSS attempt in an operator-authored field.
        disabled_reason: `<img src=x onerror=alert(1)>`,
        replay_opt_in: false,
        replay_opt_in_reason: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        updated_at: new Date("2026-01-02T00:00:00Z"),
      },
    ],
    findDestination: async (id) =>
      id === "polaris_dst_1" ? ((await makeQueries().listDestinations({}))[0] ?? null) : null,
    listApiKeys: async () => [
      {
        api_key_id: "polaris_ak_1",
        project_id: "storefront",
        environment: "production",
        source_id: "storefront-web",
        source_type: "web",
        status: "active",
        created_at: new Date("2026-01-01T00:00:00Z"),
        revoked_at: null,
        last_used_at: null,
        // Not part of ApiKeyRow — present here to prove that even if a future
        // query leaked it, the page would not render it.
        hash: SECRET_HASH,
      } as never,
    ],
    listProcessorActivations: async () => [],
    listAudit: async () => [
      {
        audit_id: "polaris_aud_1",
        created_at: new Date("2026-02-01T00:00:00Z"),
        actor_source: "declared",
        actor_label: EMAIL,
        action: "destinations.disable",
        target_type: "destination",
        target_id: "polaris_dst_1",
        project_id: "storefront",
        environment: "production",
        reason: "vendor outage",
        request_id: "req_1",
        before: { status: "active" },
        after: { status: "disabled" },
      },
    ],
    findAudit: async () => null,
    listDlq: async () => [],
    findDlq: async () => null,
    ...overrides,
  };
}

function makeIdpClient(overrides: Partial<IdpOAuthClient> = {}): IdpOAuthClient {
  return {
    buildAuthorizeUrl: (state, verifier) =>
      `${ISSUER}/oauth/authorize?state=${state}&challenge=${verifier.slice(0, 6)}`,
    exchangeCode: async (): Promise<IdpTokenResponse> => ({
      access_token: "admin-token",
      token_type: "Bearer",
      expires_in: 900,
      id_token: "id-token",
      refresh_token: "refresh-token",
    }),
    revokeRefreshToken: async () => undefined,
    buildEndSessionUrl: ({ postLogoutRedirectUri }) =>
      `${ISSUER}/oauth/end_session?post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`,
    ...overrides,
  };
}

interface BuildOptions {
  readonly admin?: AdminConfig | null;
  readonly queries?: Partial<AdminQueries>;
  readonly idpAuth?: Partial<IdpAuth>;
  readonly idpClient?: Partial<IdpOAuthClient>;
  readonly refresher?: SessionRefresher;
}

async function buildApp(options: BuildOptions = {}) {
  return buildControlPlaneApp({
    config: makeConfig(options.admin === undefined ? makeAdminConfig() : options.admin),
    // The JSON API's own auth is irrelevant here; a stub keeps Postgres out.
    operatorTokenRepository: { findById: async () => null, touchLastUsedAt: async () => undefined },
    adminQueries: makeQueries(options.queries),
    idpAuth: makeIdpAuth(options.idpAuth),
    idpClient: makeIdpClient(options.idpClient),
    ...(options.refresher !== undefined ? { refresher: options.refresher } : {}),
    installShutdown: false,
  });
}

/** Session cookie header for a fixture token, plus a matching identity cookie. */
function sessionCookie(token: string, subject = SUBJECT): string {
  const identity = new AdminIdentityCodec(SESSION_SECRET).encode({
    sub: subject,
    email: EMAIL,
    name: "Ops Person",
    idToken: "id-token",
  });
  return `polaris_admin_session=${token}; polaris_admin_identity=${identity}`;
}

function setCookies(headers: Record<string, unknown>): string[] {
  const raw = headers["set-cookie"];
  if (Array.isArray(raw)) return raw as string[];
  return typeof raw === "string" ? [raw] : [];
}

// ---------------------------------------------------------------------------

describe("admin UI — access control", () => {
  it("redirects an unauthenticated browser to login, remembering where it was going", async () => {
    const app = await buildApp();
    const res = await app.app.inject({ method: "GET", url: "/admin/projects" });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("/admin/auth/login");
    expect(res.headers["location"]).toContain("next=%2Fadmin%2Fprojects");
    await app.app.close();
  });

  it("serves the login page unauthenticated", async () => {
    const app = await buildApp();
    const res = await app.app.inject({ method: "GET", url: "/admin/auth/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Continue with Idp");
    await app.app.close();
  });

  it.each([
    ["owner-token", 200],
    ["admin-token", 200],
  ])("admits %s", async (token, status) => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie(token) },
    });
    expect(res.statusCode).toBe(status);
    expect(res.body).toContain(EMAIL);
    await app.app.close();
  });

  it.each([
    "member-token",
    "viewer-token",
    "none-token",
    "null-role-token",
  ])("denies %s with a 403 page rather than a redirect loop", async (token) => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie(token) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Access denied");
    await app.app.close();
  });

  it("denies a service token instead of crashing on NotAUserTokenError", async () => {
    // `Passport.platformRole` THROWS on a client-credentials token. A guard
    // that read it without checking `passport.user` would 500 here.
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie("service-token", "svc_client") },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("NotAUserTokenError");
    await app.app.close();
  });

  it("sends an expired session back to login with a reason it can explain", async () => {
    const app = await buildApp({
      idpAuth: {
        verifyAccessToken: async () => {
          throw new IdpAuthError("expired", "token_expired");
        },
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie("admin-token") },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=token_expired");
    await app.app.close();
  });

  it("refuses an Idp bearer token on an admin page, and says 401 rather than 500", async () => {
    // The service-wide bearer hook runs before this scope and rejects anything
    // that is not a polaris_ot_<uuidv7>.<secret> operator token. Admin auth is
    // cookie-only by construction; the point of this case is that the refusal
    // surfaces as the 401 it is, rendered as HTML by the admin error handler.
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: "Bearer some-idp-access-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.app.close();
  });

  it("does not register any admin route when the UI is disabled", async () => {
    const app = await buildApp({ admin: null });
    const res = await app.app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(404);
    // The parent scope's Problem handler answers, not the admin HTML one.
    expect(res.headers["content-type"]).toContain("application/problem+json");
    await app.app.close();
  });
});

describe("admin UI — OAuth flow", () => {
  it("starts the flow by setting single-use state and PKCE cookies", async () => {
    const app = await buildApp();
    const res = await app.app.inject({ method: "GET", url: "/admin/auth/start" });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("/oauth/authorize");

    const cookies = setCookies(res.headers);
    const state = cookies.find((c) => c.startsWith("polaris_admin_state="));
    const pkce = cookies.find((c) => c.startsWith("polaris_admin_pkce="));
    expect(state).toBeDefined();
    expect(pkce).toBeDefined();
    // Scoped tightly and short-lived: they exist for one redirect round trip.
    expect(state).toContain("Path=/admin/auth");
    expect(state).toContain("HttpOnly");
    expect(state).toContain("Max-Age=300");
    // Lax, not Strict — the Idp callback is a cross-site top-level GET and
    // Strict would withhold these exactly when the callback needs them.
    expect(state?.toLowerCase()).toContain("samesite=lax");
    await app.app.close();
  });

  it("completes the callback for an admin, setting session, identity, and refresh cookies", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?code=abc&state=xyz",
      headers: { cookie: "polaris_admin_state=xyz; polaris_admin_pkce=verifier" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/admin");

    const cookies = setCookies(res.headers);
    expect(cookies.some((c) => c.startsWith("polaris_admin_session=admin-token"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("polaris_admin_identity="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("polaris_admin_refresh=refresh-token"))).toBe(true);
    // Flow cookies are cleared on the way out.
    expect(cookies.some((c) => c.startsWith("polaris_admin_state=;"))).toBe(true);
    await app.app.close();
  });

  it("refuses the callback for a viewer WITHOUT setting any session cookie", async () => {
    // The role check runs before cookies are written, so a denied operator
    // never holds a session at all.
    const app = await buildApp({
      idpClient: {
        exchangeCode: async () => ({
          access_token: "viewer-token",
          token_type: "Bearer",
          expires_in: 900,
          id_token: "id-token",
          refresh_token: "refresh-token",
        }),
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?code=abc&state=xyz",
      headers: { cookie: "polaris_admin_state=xyz; polaris_admin_pkce=verifier" },
    });
    expect(res.statusCode).toBe(403);
    expect(setCookies(res.headers).some((c) => c.startsWith("polaris_admin_session=v"))).toBe(
      false,
    );
    await app.app.close();
  });

  it("restarts the flow on a state mismatch, without exchanging the code", async () => {
    const exchangeCode = vi.fn();
    const app = await buildApp({ idpClient: { exchangeCode } });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?code=abc&state=attacker",
      headers: { cookie: "polaris_admin_state=xyz; polaris_admin_pkce=verifier" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=state_mismatch");
    expect(exchangeCode).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses to exchange a code with no PKCE verifier", async () => {
    // This client is confidential, so Idp would happily redeem the code
    // without a verifier — losing exactly the binding PKCE exists to provide.
    const exchangeCode = vi.fn();
    const app = await buildApp({ idpClient: { exchangeCode } });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?code=abc&state=xyz",
      headers: { cookie: "polaris_admin_state=xyz" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=missing_verifier");
    expect(exchangeCode).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("sends an Idp error back to login", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?error=access_denied&state=xyz",
      headers: { cookie: "polaris_admin_state=xyz; polaris_admin_pkce=verifier" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=idp_error");
    await app.app.close();
  });

  it("ignores an identity whose subject differs from the access token's", async () => {
    const app = await buildApp({
      idpAuth: {
        verifyIdToken: async () => ({
          sub: "someone_else",
          email: "other@example.com",
          name: null,
        }),
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/callback?code=abc&state=xyz",
      headers: { cookie: "polaris_admin_state=xyz; polaris_admin_pkce=verifier" },
    });
    expect(res.statusCode).toBe(303);
    // Session still granted — the access token is the credential — but no
    // identity cookie, so the audit actor falls back to the subject rather
    // than someone else's email.
    const cookies = setCookies(res.headers);
    expect(cookies.some((c) => c.startsWith("polaris_admin_session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("polaris_admin_identity=e"))).toBe(false);
    await app.app.close();
  });

  it("refuses a post-login redirect to another origin", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/auth/start?next=https://evil.example/steal",
    });
    const cookies = setCookies(res.headers);
    expect(cookies.some((c) => c.startsWith("polaris_admin_next="))).toBe(false);
    await app.app.close();
  });

  it("revokes the refresh token and clears cookies on logout", async () => {
    const revokeRefreshToken = vi.fn(async () => undefined);
    const app = await buildApp({ idpClient: { revokeRefreshToken } });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/auth/logout",
      headers: {
        cookie: `${sessionCookie("admin-token")}; polaris_admin_refresh=refresh-token`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(res.statusCode).toBe(303);
    expect(revokeRefreshToken).toHaveBeenCalledWith("refresh-token");
    // Ends the Idp session too, or the next visit re-authenticates silently.
    expect(res.headers["location"]).toContain("/oauth/end_session");
    expect(setCookies(res.headers).some((c) => c.startsWith("polaris_admin_session=;"))).toBe(true);
    await app.app.close();
  });

  it("refuses a cross-origin logout before touching anything", async () => {
    const revokeRefreshToken = vi.fn(async () => undefined);
    const app = await buildApp({ idpClient: { revokeRefreshToken } });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/auth/logout",
      headers: {
        cookie: sessionCookie("admin-token"),
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(revokeRefreshToken).not.toHaveBeenCalled();
    await app.app.close();
  });
});

describe("admin UI — scope isolation", () => {
  it("does not let an admin cookie authenticate the JSON API", async () => {
    // The single most important property in this file. The admin plugin's
    // cookie auth must stay inside /admin; /v1/* remains bearer-only.
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/v1/whoami",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ actor: { source: "cli", label: "cli" } });
    await app.app.close();
  });

  it("answers an unknown admin path with HTML, not a JSON problem document", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/nope",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.app.close();
  });

  it("answers an unknown API path with a JSON problem document", async () => {
    const app = await buildApp();
    const res = await app.app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    await app.app.close();
  });

  it("renders an HTML 500 with no stack trace when a query throws", async () => {
    const app = await buildApp({
      queries: {
        counts: async () => {
          throw new Error("connection terminated unexpectedly");
        },
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).not.toContain("connection terminated");
    expect(res.body).not.toContain("at Object");
    await app.app.close();
  });

  it("serves the stylesheet without a session", async () => {
    const app = await buildApp();
    const res = await app.app.inject({ method: "GET", url: "/admin/assets/app.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    await app.app.close();
  });
});

describe("admin UI — pages", () => {
  it("lists projects and links to their detail pages", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/projects",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("storefront");
    expect(res.body).toContain("/admin/projects/storefront");
    await app.app.close();
  });

  it("404s an unknown project", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/projects/nope",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(404);
    await app.app.close();
  });

  it("never renders an API key hash", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/keys",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("polaris_ak_1");
    expect(res.body).not.toContain(SECRET_HASH);
    expect(res.body).not.toContain("argon2id");
    await app.app.close();
  });

  it("renders key issuance as a CLI command rather than a button", async () => {
    // Show-once secrets never cross the UI's HTTP boundary.
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/keys?project=storefront&environment=production",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.body).toContain("polaris keys create --project storefront --env production");
    await app.app.close();
  });

  it("escapes an operator-authored field carrying markup", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations/polaris_dst_1",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<img src=x");
    expect(res.body).toContain("&lt;img src=x");
    await app.app.close();
  });

  it("flags a production row in the rendered output", async () => {
    const app = await buildApp();
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.body).toContain("badge badge-prod");
    await app.app.close();
  });

  it("passes list filters through to the query layer", async () => {
    const listDestinations = vi.fn(async () => []);
    const app = await buildApp({ queries: { listDestinations } });
    await app.app.inject({
      method: "GET",
      url: "/admin/destinations?project=storefront&environment=production&status=disabled",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(listDestinations).toHaveBeenCalledWith({
      projectId: "storefront",
      environment: "production",
      status: "disabled",
    });
    await app.app.close();
  });

  it("treats a blank filter as absent rather than as an empty-string match", async () => {
    const listDestinations = vi.fn(async () => []);
    const app = await buildApp({ queries: { listDestinations } });
    await app.app.inject({
      method: "GET",
      url: "/admin/destinations?project=&environment=",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(listDestinations).toHaveBeenCalledWith({
      projectId: undefined,
      environment: undefined,
      status: undefined,
    });
    await app.app.close();
  });

  it("caps audit reads at the configured page size", async () => {
    const listAudit = vi.fn(async () => []);
    const app = await buildApp({
      admin: makeAdminConfig({ pageSize: 25 }),
      queries: { listAudit },
    });
    await app.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(listAudit).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
    await app.app.close();
  });

  it("does not select or render a DLQ payload", async () => {
    const listDlq = vi.fn(async () => []);
    const app = await buildApp({ queries: { listDlq } });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/dlq",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(200);
    // The filter object has no payload-bearing option at all — the column is
    // never fetched, so it cannot leak into a page.
    expect(listDlq).toHaveBeenCalledWith(
      expect.objectContaining({ includeResolved: false, limit: 50 }),
    );
    await app.app.close();
  });
});

describe("admin UI — session refresh in the guard", () => {
  /** Fails the first verification (expired), then accepts the refreshed token. */
  function expiringThenValid(): Partial<IdpAuth> {
    let calls = 0;
    return {
      verifyAccessToken: async (token: string) => {
        calls += 1;
        if (calls === 1) throw new IdpAuthError("expired", "token_expired");
        const passport = TOKENS[token];
        if (passport === undefined) throw new IdpAuthError("invalid", "invalid_token");
        return passport;
      },
    };
  }

  it("refreshes an expired session in place and serves the page", async () => {
    const app = await buildApp({
      idpAuth: expiringThenValid(),
      refresher: {
        refresh: async () => ({
          ok: true,
          tokens: {
            accessToken: "owner-token",
            refreshToken: "refresh-rotated",
            expiresIn: 900,
            tokenType: "Bearer",
          },
        }),
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${sessionCookie("owner-token")}; polaris_admin_refresh=refresh-old` },
    });

    // The operator's request completes rather than bouncing through Idp.
    expect(res.statusCode).toBe(200);

    const cookies = setCookies(res.headers);
    expect(cookies.some((c) => c.startsWith("polaris_admin_session=owner-token"))).toBe(true);
    // The rotated refresh token MUST replace the old one — Idp retired it on
    // redemption, so leaving the old cookie would replay a dead grant.
    expect(cookies.some((c) => c.startsWith("polaris_admin_refresh=refresh-rotated"))).toBe(true);
    await app.app.close();
  });

  it("sends the operator to login when the grant is dead", async () => {
    const app = await buildApp({
      idpAuth: expiringThenValid(),
      refresher: { refresh: async () => ({ ok: false, reason: "invalid_grant" }) },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${sessionCookie("owner-token")}; polaris_admin_refresh=refresh-old` },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=token_expired");
    await app.app.close();
  });

  it("does not attempt a refresh with no refresh cookie", async () => {
    const refresh = vi.fn();
    const app = await buildApp({
      idpAuth: expiringThenValid(),
      refresher: { refresh },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: sessionCookie("owner-token") },
    });
    expect(res.statusCode).toBe(303);
    expect(refresh).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("does not try to refresh a revoked session — Idp already decided", async () => {
    const refresh = vi.fn();
    const app = await buildApp({
      idpAuth: {
        verifyAccessToken: async () => {
          throw new IdpAuthError("revoked", "token_revoked");
        },
      },
      refresher: { refresh },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${sessionCookie("owner-token")}; polaris_admin_refresh=refresh-old` },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toContain("reason=token_revoked");
    expect(refresh).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses a refreshed token it cannot verify rather than trusting its source", async () => {
    const app = await buildApp({
      idpAuth: {
        verifyAccessToken: async () => {
          throw new IdpAuthError("expired", "token_expired");
        },
      },
      refresher: {
        refresh: async () => ({
          ok: true,
          tokens: {
            accessToken: "unverifiable",
            refreshToken: "refresh-rotated",
            expiresIn: 900,
            tokenType: "Bearer",
          },
        }),
      },
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${sessionCookie("owner-token")}; polaris_admin_refresh=refresh-old` },
    });
    expect(res.statusCode).toBe(303);
    await app.app.close();
  });
});
