/**
 * Mutation guardrail tests.
 *
 * The service-wide production-mutation gate cannot refuse anyone who reaches
 * these routes — its only rule is `actor.source !== "declared"`, and every
 * Idp-authenticated operator is `declared` by construction. So the guardrails
 * are entirely local, and these cases are what hold them in place:
 *
 *   - the row's environment decides the required role, not the service's
 *   - production needs POLARIS_ADMIN_PRODUCTION_MIN_ROLE (default owner)
 *   - the confirmation is the human label, typed exactly
 *   - the reason is mandatory and lands in the audit row
 *   - a same-origin check runs before anything is read or written
 *   - a no-op transition writes NO audit row
 */

import { Passport, PLATFORM_ROLE_CLAIM, type PlatformRole } from "@polaris/idp";
import { describe, expect, it, vi } from "vitest";
import type { AdminMutations, MutationOutcome } from "../src/admin/actions/mutations.js";
import type { AdminConfig } from "../src/admin/config.js";
import { AdminIdentityCodec } from "../src/admin/identity.js";
import type { IdpAuth } from "../src/admin/idp-auth.js";
import { IdpAuthError } from "../src/admin/idp-auth.js";
import type { AdminQueries, DestinationRow } from "../src/admin/queries.js";
import { buildControlPlaneApp } from "../src/app.js";
import type { ControlPlaneConfig } from "../src/config.js";

const SESSION_SECRET = "s".repeat(48);
const ISSUER = "http://localhost:3011";
const SUBJECT = "usr_0196000000000000";
const EMAIL = "ops@example.com";
const LABEL = "storefront-prod";

function destination(overrides: Partial<DestinationRow> = {}): DestinationRow {
  return {
    destination_id: "polaris_dst_1",
    project_id: "storefront",
    environment: "development",
    vendor: "ga4",
    instance_label: LABEL,
    secret_ref: "env:GA4_TOKEN",
    status: "active",
    mode: "live",
    max_concurrency: 4,
    max_rps: 50,
    retry_policy: "standard",
    dead_letter_threshold: 5,
    disabled_reason: null,
    replay_opt_in: false,
    replay_opt_in_reason: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

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
      clientSecret: "secret",
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
      // Deliberately NOT production: the point is that the row's environment
      // drives the decision, not the service's.
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

function passportFor(role: PlatformRole): Passport {
  return new Passport({
    iss: ISSUER,
    sub: SUBJECT,
    aud: ISSUER,
    iat: 0,
    exp: 9_999_999_999,
    jti: "tok_1",
    sid: "ses_1",
    [PLATFORM_ROLE_CLAIM]: role,
  } as never);
}

function sessionCookie(role: PlatformRole): string {
  const identity = new AdminIdentityCodec(SESSION_SECRET).encode({
    sub: SUBJECT,
    email: EMAIL,
    name: "Ops",
    idToken: null,
  });
  return `polaris_admin_session=${role}-token; polaris_admin_identity=${identity}`;
}

interface Harness {
  readonly row: DestinationRow;
  readonly config?: AdminConfig;
  readonly mutations?: AdminMutations | null;
}

/** Both destination verbs share one spy; everything else must not be called. */
function stubMutations(spy: ReturnType<typeof vi.fn>): AdminMutations {
  const notCalled = async (): Promise<MutationOutcome> => {
    throw new Error("unexpected mutation");
  };
  return {
    disableDestination: spy as never,
    enableDestination: spy as never,
    revokeApiKey: notCalled as never,
    enableProcessor: notCalled as never,
    disableProcessor: notCalled as never,
  };
}

async function buildApp(harness: Harness) {
  const idpAuth: IdpAuth = {
    verifyAccessToken: async (token: string) => {
      const role = token.replace("-token", "") as PlatformRole;
      if (!["owner", "admin", "member", "viewer", "none"].includes(role)) {
        throw new IdpAuthError("bad", "invalid_token");
      }
      return passportFor(role);
    },
    verifyIdToken: async () => null,
  };

  const queries = {
    counts: async () => ({
      projects: 0,
      sources: 0,
      destinationsActive: 0,
      destinationsInactive: 0,
      apiKeysActive: 0,
      dlqUnresolved: 0,
    }),
    listProjects: async () => [],
    findProject: async () => null,
    listSources: async () => [],
    listDestinations: async () => [],
    findDestination: async (id: string) => (id === harness.row.destination_id ? harness.row : null),
    listApiKeys: async () => [],
    listProcessorActivations: async () => [],
    listAudit: async () => [],
    findAudit: async () => null,
    listDlq: async () => [],
    findDlq: async () => null,
  } satisfies AdminQueries;

  return buildControlPlaneApp({
    config: makeConfig(harness.config ?? makeAdminConfig()),
    operatorTokenRepository: { findById: async () => null, touchLastUsedAt: async () => undefined },
    adminQueries: queries,
    idpAuth,
    idpClient: {
      buildAuthorizeUrl: () => `${ISSUER}/oauth/authorize`,
      exchangeCode: async () => {
        throw new Error("unused");
      },
      revokeRefreshToken: async () => undefined,
      buildEndSessionUrl: () => `${ISSUER}/oauth/end_session`,
    },
    ...(harness.mutations !== undefined ? { adminMutations: harness.mutations } : {}),
    installShutdown: false,
  });
}

const APPLIED: MutationOutcome = { applied: true, auditId: "polaris_aud_1" };

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  "sec-fetch-site": "same-origin",
};

describe("admin mutations — authorization", () => {
  it("applies a development mutation for an admin", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // The reason reaches the audit layer verbatim, trimmed.
    expect(spy).toHaveBeenCalledWith(
      "polaris_dst_1",
      "vendor outage on their side",
      expect.objectContaining({ actorLabel: EMAIL }),
    );
    await app.app.close();
  });

  it("refuses a PRODUCTION row for an admin, even though the service is not production", async () => {
    // This is the case the service-wide gate misses entirely: it keys on the
    // process's POLARIS_ENV (here "local"), so it would wave this through.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination({ environment: "production" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body).toContain("owner");
    await app.app.close();
  });

  it("allows a production row for an owner", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination({ environment: "production" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await app.app.close();
  });

  it("honours POLARIS_ADMIN_PRODUCTION_MIN_ROLE=admin as the opt-out", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination({ environment: "production" }),
      config: makeAdminConfig({ productionMinRole: "admin" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    await app.app.close();
  });

  it("never admits a viewer to the route at all", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("viewer") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });
});

describe("admin mutations — confirmation ritual", () => {
  it("refuses a wrong confirmation and re-renders with what was typed", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "storefront-staging", reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    // What they typed survives, so a typo does not cost the whole form.
    expect(res.body).toContain("storefront-staging");
    expect(res.body).toContain("vendor outage on their side");
    await app.app.close();
  });

  it("refuses the destination id in place of the label", async () => {
    // The ritual is only worth anything if it cannot be satisfied by
    // copy-pasting the identifier already on screen.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "polaris_dst_1", reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses a reason that is too short", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "oops" }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses whitespace padding as a reason", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "               " }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });
});

describe("admin mutations — same-origin and no-op", () => {
  it("refuses a cross-origin POST before reading the row", async () => {
    const spy = vi.fn(async () => APPLIED);
    const findDestination = vi.fn(async () => destination());
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie("admin"),
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect(findDestination).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("reports a no-op transition and says no audit record was written", async () => {
    // The guarded UPDATE matched nothing, so the shared mutation wrote no
    // audit row. The page has to say that rather than implying an event.
    const spy = vi.fn(async (): Promise<MutationOutcome> => ({ applied: false, auditId: null }));
    const app = await buildApp({
      row: destination({ status: "disabled", disabled_reason: "already off" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/enable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "turning it back on now" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("no audit record was written");
    await app.app.close();
  });

  it("404s a destination that vanished between render and submit", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/gone/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });
});

describe("admin mutations — read-only deployment", () => {
  it("does not register mutation routes when mutations are absent", async () => {
    const app = await buildApp({ row: destination(), mutations: null });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(404);
    await app.app.close();
  });

  it("renders no action forms on the detail page when mutations are absent", async () => {
    const app = await buildApp({ row: destination(), mutations: null });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations/polaris_dst_1",
      headers: { cookie: sessionCookie("owner") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Disable destination");
    await app.app.close();
  });

  it("explains rather than offering a form when the role is too low for the row", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination({ environment: "production" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations/polaris_dst_1",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Disable destination");
    expect(res.body).toContain("requires the");
    await app.app.close();
  });

  it("offers only the transition that would change something", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination({ status: "disabled" }),
      mutations: stubMutations(spy),
    });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations/polaris_dst_1",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.body).toContain("Enable destination");
    expect(res.body).not.toContain("Disable destination");
    await app.app.close();
  });
});
