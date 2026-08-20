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
 *   - the reason is mandatory on the ritual forms and lands in the audit
 *     row; a routine project-config edit has none and records NULL
 *   - a same-origin check runs before anything is read or written
 *   - a no-op transition writes NO audit row
 */

import { Passport, PLATFORM_ROLE_CLAIM, type PlatformRole } from "@polaris/auth";
import { SECRET_MASK } from "@polaris/tenancy-control-plane";
import type { ProjectConfigRow } from "@polaris/persistence-control-plane";
import { describe, expect, it, vi } from "vitest";
import type { AdminMutations, MutationOutcome } from "../src/admin/actions/mutations.js";
import type { AdminConfig } from "../src/admin/config.js";
import { AdminIdentityCodec } from "../src/admin/identity.js";
import type { IdpAuth } from "../src/admin/idp-auth.js";
import { IdpAuthError } from "../src/admin/idp-auth.js";
import type { AdminQueries, DestinationRow, ProjectRow } from "../src/admin/queries.js";
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

const API_KEY = {
  api_key_id: "polaris_ak_1",
  project_id: "storefront",
  environment: "production",
  source_id: "storefront-web",
  source_type: "web",
  status: "active",
  created_at: new Date("2026-01-01T00:00:00Z"),
  revoked_at: null,
  last_used_at: null,
  // Not part of ApiKeyRow. Present so the assertion below is about a real
  // hash value leaking, not about the page happening to say "argon2id" in
  // its explanatory copy.
  hash: "$argon2id$v=19$m=65536$NEVER$RENDER-THIS",
} as const;

const DLQ_ROW = {
  dlq_id: "polaris_dlq_1",
  destination_id: "polaris_dst_1",
  project_id: "storefront",
  environment: "development",
  vendor: "ga4",
  event_id: "evt_1",
  reason: "mapper_failed",
  error_class: "mapping",
  attempts: 3,
  created_at: new Date("2026-01-01T00:00:00Z"),
  resolved_at: null,
  resolved_by: null,
} as const;

const ACTIVATION = {
  processor_name: "analytics-projector",
  processor_version: "v1",
  project_id: "storefront",
  environment: "development",
  enabled_state: "enabled",
  enabled_at: new Date("2026-01-01T00:00:00Z"),
  disabled_at: null,
  last_changed_by: "cli",
} as const;

function makeAdminConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
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

function makeConfig(admin: AdminConfig): ControlPlaneConfig {
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
  readonly project?: ProjectRow;
  readonly configRows?: readonly ProjectConfigRow[];
}

/** Every mutation shares one spy, so a test asserts on calls, not on which. */
function stubMutations(spy: ReturnType<typeof vi.fn>): AdminMutations {
  return {
    disableDestination: spy as never,
    enableDestination: spy as never,
    revokeApiKey: spy as never,
    markDlqResolved: spy as never,
    enableProcessor: spy as never,
    disableProcessor: spy as never,
    setProjectConfig: spy as never,
    unsetProjectConfig: spy as never,
    invalidateProjectConfig: spy as never,
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
    findProject: async (id: string) =>
      harness.project !== undefined && id === harness.project.project_id ? harness.project : null,
    listProjectConfig: async () => harness.configRows ?? [],
    listSources: async () => [],
    listDestinations: async () => [],
    findDestination: async (id: string) => (id === harness.row.destination_id ? harness.row : null),
    listApiKeys: async () => [API_KEY],
    findApiKey: async (id: string) => (id === API_KEY.api_key_id ? API_KEY : null),
    listProcessorActivations: async () => [ACTIVATION],
    listProcessorRuns: async () => [],
    listAudit: async () => [],
    findAudit: async () => null,
    listDlq: async () => [DLQ_ROW],
    findDlq: async (id: string) => (id === DLQ_ROW.dlq_id ? DLQ_ROW : null),
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

describe("admin mutations — the confirmation fold", () => {
  it("puts the button beside the title and keeps its confirmation folded", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/destinations/polaris_dst_1",
      headers: { cookie: sessionCookie("admin") },
    });
    // The trigger is inside the block the h1 lives in, not down the page.
    const head = res.body.slice(
      res.body.indexOf('<div class="page-title">'),
      res.body.indexOf('<div class="page-lede">'),
    );
    expect(head).toContain("Disable destination");
    // Closed on arrival: nobody asked to disable anything by opening the page.
    expect(res.body).toContain('<details class="confirm">');
    expect(res.body).not.toContain('<details class="confirm" open>');
    await app.app.close();
  });

  it("re-opens the fold when the submission came back refused", async () => {
    // The refusal and what the operator typed are inside the fold. Rendering
    // it closed would report the failure by appearing to have done nothing.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "storefront-staging", reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('<details class="confirm" open>');
    await app.app.close();
  });

  it("reports the result above the page rather than at the foot of it", async () => {
    // The POST re-renders the whole page, which the browser shows from the
    // top — a result below the related links is a result nobody reads.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/destinations/polaris_dst_1/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: LABEL, reason: "vendor outage on their side" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.indexOf("Destination disabled.")).toBeLessThan(
      res.body.indexOf("Delivery limits"),
    );
    await app.app.close();
  });
});

describe("admin mutations — API keys", () => {
  it("revokes a production key for an owner, confirmed by the source id", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/keys/polaris_ak_1/revoke",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({ confirm: "storefront-web", reason: "rotating for the audit" }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      "polaris_ak_1",
      "rotating for the audit",
      expect.objectContaining({ actorLabel: EMAIL }),
    );
    await app.app.close();
  });

  it("refuses a production key revoke for an admin", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/keys/polaris_ak_1/revoke",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "storefront-web", reason: "rotating for the audit" }),
    });
    expect(res.statusCode).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses the key id in place of the source id", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/keys/polaris_ak_1/revoke",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({ confirm: "polaris_ak_1", reason: "rotating for the audit" }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("never renders a hash on the key detail page", async () => {
    const app = await buildApp({ row: destination(), mutations: null });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/keys/polaris_ak_1",
      headers: { cookie: sessionCookie("owner") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("polaris_ak_1");
    expect(res.body).not.toContain("$argon2id$v=19$m=65536$NEVER$RENDER-THIS");
    await app.app.close();
  });
});

describe("admin mutations — processor activations", () => {
  it("disables an activation, carrying its four-column key through the form", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/processors/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        name: "analytics-projector",
        version: "v1",
        project: "storefront",
        environment: "development",
        confirm: "analytics-projector",
        reason: "investigating a mapping bug",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      {
        processor_name: "analytics-projector",
        processor_version: "v1",
        project_id: "storefront",
        environment: "development",
      },
      "investigating a mapping bug",
      expect.objectContaining({ actorLabel: EMAIL }),
    );
    await app.app.close();
  });

  it("404s an activation key that matches no row", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/processors/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        name: "analytics-projector",
        version: "v9",
        project: "storefront",
        environment: "development",
        confirm: "analytics-projector",
        reason: "investigating a mapping bug",
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("puts the activation key in hidden fields inside the form, not around it", async () => {
    // A wrapping <form> would be nested markup, which browsers do not submit —
    // the key would silently never arrive.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/processors/activation?name=analytics-projector&version=v1&project=storefront&environment=development",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="version" value="v1"');
    // Exactly one <form> in the actions block.
    expect(res.body.match(/<form method="post" action="\/admin\/processors/g)).toHaveLength(1);
    await app.app.close();
  });

  it("puts the button beside the title and keeps its confirmation folded", async () => {
    // The same fold as a destination's: an activation page opens on the state
    // of the row, not on a form asking to change it.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/processors/activation?name=analytics-projector&version=v1&project=storefront&environment=development",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.statusCode).toBe(200);
    const head = res.body.slice(
      res.body.indexOf('<div class="page-title">'),
      res.body.indexOf('<dl class="detail">'),
    );
    expect(head).toContain("Disable processor");
    expect(res.body).toContain('<details class="confirm">');
    expect(res.body).not.toContain('<details class="confirm" open>');
    await app.app.close();
  });

  it("re-opens the fold when the submission came back refused", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/processors/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        name: "analytics-projector",
        version: "v1",
        project: "storefront",
        environment: "development",
        confirm: "analytics-projecter",
        reason: "investigating a mapping bug",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('<details class="confirm" open>');
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("reports the result above the page rather than at the foot of it", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/processors/disable",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        name: "analytics-projector",
        version: "v1",
        project: "storefront",
        environment: "development",
        confirm: "analytics-projector",
        reason: "investigating a mapping bug",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.indexOf("Processor disabled for this project")).toBeLessThan(
      res.body.indexOf('<dl class="detail">'),
    );
    await app.app.close();
  });

  it("explains rather than offering a button when the role is too low", async () => {
    // A production combination nobody has decided about: synthesized, and an
    // admin may not act on it. The explanation replaces the button entirely.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/processors/activation?name=analytics-projector&version=v1&project=storefront&environment=production",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Disable processor");
    expect(res.body).toContain("requires the");
    await app.app.close();
  });
});

describe("admin mutations — DLQ triage", () => {
  it("marks a row resolved, confirmed by the vendor", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/dlq/polaris_dlq_1/resolve",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "ga4", reason: "replayed via the CLI instead" }),
    });
    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ dlqId: "polaris_dlq_1", vendor: "ga4" }),
      "replayed via the CLI instead",
      expect.objectContaining({ actorLabel: EMAIL }),
    );
    await app.app.close();
  });

  it("says plainly that resolving redelivers nothing", async () => {
    // The whole risk of this control is an operator thinking it retried.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "GET",
      url: "/admin/dlq/polaris_dlq_1",
      headers: { cookie: sessionCookie("admin") },
    });
    expect(res.body).toContain("does NOT redeliver");
    await app.app.close();
  });

  it("still keeps retry on the CLI, because republishing needs a broker", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/dlq/polaris_dlq_1/retry",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({ confirm: "ga4", reason: "retrying this one now" }),
    });
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses a wrong confirmation", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({ row: destination(), mutations: stubMutations(spy) });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/dlq/polaris_dlq_1/resolve",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ confirm: "braze", reason: "replayed via the CLI instead" }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });
});

// ---------------------------------------------------------------------------
// Project-config writes
// ---------------------------------------------------------------------------

const PROJECT: ProjectRow = {
  project_id: "storefront",
  display_name: "Storefront",
  owner: "storefront-platform",
  description: "test project",
  status: "active",
  created_at: new Date("2026-05-12T10:00:00.000Z"),
};

/**
 * A stored production secret: the shape whose edits demand the ritual.
 *
 * `value` is `SECRET_MASK` because that is what `listProjectConfig` returns
 * for a secret row — the panel never receives the plaintext. A fixture
 * carrying a real-looking credential here would be testing a shape the
 * handler cannot actually be given.
 */
const SECRET_ROW: ProjectConfigRow = {
  project_id: "storefront",
  environment: "production",
  namespace: "meta-capi",
  config_key: "access_token",
  value: SECRET_MASK,
  is_secret: true,
  updated_at: "2026-08-13T09:30:00.000Z",
  updated_by: "ops@example.com",
};

describe("admin mutations — project-config writes", () => {
  it("refuses a production secret set with an EMPTY confirm — the ritual is server-decided", async () => {
    // The defect this pins: an earlier revision treated an absent confirm
    // field as "ritual satisfied", so a stripped form or a curl bypassed the
    // typed confirmation on exactly the shapes it exists for. Whether the
    // ritual applies must be computed server-side from the row and schema,
    // never inferred from which fields the form happened to carry.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
      configRows: [SECRET_ROW],
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/production/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({
        namespace: "meta-capi",
        key: "access_token",
        value: "EAAB-rotated-token",
        secret: "true",
        expected_updated_at: SECRET_ROW.updated_at,
        reason: "rotating the leaked token",
        // no confirm field at all
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("applies the same set when the label is typed, and FORCES is_secret", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
      configRows: [SECRET_ROW],
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/production/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({
        namespace: "meta-capi",
        key: "access_token",
        value: "EAAB-rotated-token",
        // Deliberately OMITTED: the stored row is a secret, and a write that
        // drops the flag must not demote a credential slot to plaintext.
        // secret: absent
        expected_updated_at: SECRET_ROW.updated_at,
        reason: "rotating the leaked token",
        confirm: "meta-capi.access_token",
      }),
    });
    expect(res.statusCode).toBe(303);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ isSecret: true, configKey: "access_token" }),
      "rotating the leaked token",
      expect.anything(),
    );
    await app.app.close();
  });

  it("refuses a write to an environment that does not exist", async () => {
    // The GET tab falls back to development because a tab is display; a
    // typoed WRITE URL must fail, not land the write somewhere else.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/prodution/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({
        namespace: "ingest",
        key: "rate_limit_rps",
        value: "5000",
        expected_updated_at: "",
        reason: "raising the launch budget",
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("refuses declaring a key that already exists — add is not a stealth overwrite", async () => {
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
      configRows: [
        {
          ...SECRET_ROW,
          environment: "development",
          namespace: "ingest",
          config_key: "rate_limit_rps",
          value: 5000,
          is_secret: false,
        },
      ],
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/development/add",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        namespace: "ingest",
        key: "rate_limit_rps",
        value: "9000",
        reason: "trying to re-declare it",
      }),
    });
    expect(res.statusCode).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });

  it("applies an ordinary development edit with no ritual and no reason", async () => {
    // The everyday path: a value and a Save button. The form carries no
    // `confirm` and no `reason` because the panel does not render either for
    // an edit this cheap, and the handler must not demand what it did not
    // ask for. `audit_records.reason` is nullable for exactly this shape.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/development/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({
        namespace: "ingest",
        key: "rate_limit_rps",
        value: "5000",
        expected_updated_at: "",
      }),
    });
    expect(res.statusCode).toBe(303);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ isSecret: false, value: 5000 }),
      null,
      expect.anything(),
    );
    await app.app.close();
  });

  it("lands on the Variables tab after a write, not the project overview", async () => {
    // The panel is one tab of five now. A redirect that dropped the tab would
    // return the operator to a page with no sign of the change they just made.
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(vi.fn(async () => APPLIED)),
      project: PROJECT,
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/production/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({
        namespace: "ingest",
        key: "rate_limit_rps",
        value: "5000",
        expected_updated_at: "",
      }),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/admin/projects/storefront?tab=variables&env=production");
    await app.app.close();
  });

  it("refuses an unstorable key name with a message, not a 500", async () => {
    // `project_config_key_format` and `project_config_namespace_format` are
    // CHECK constraints. A violation used to travel out of the write path
    // unhandled and reach the operator as "Something went wrong" plus a
    // request id — for a typo in a form field. The CLI has always refused
    // these with a sentence; the panel now does too.
    const spy = vi.fn(async () => APPLIED);
    // `as const` so the destructure yields `string`, not `string | undefined`:
    // under `noUncheckedIndexedAccess` a bare `string[][]` makes both halves
    // optional, and `form()` takes strings.
    for (const [namespace, key] of [
      ["MyNs", "ok_key"],
      ["ab", "ok_key"],
      ["ok-ns", "BadKey"],
      ["ok-ns", "trailing_"],
      ["", "ok_key"],
      ["ok-ns", ""],
    ] as const) {
      const app = await buildApp({
        row: destination(),
        mutations: stubMutations(spy),
        project: PROJECT,
      });
      const res = await app.app.inject({
        method: "POST",
        url: "/admin/projects/storefront/config/development/add",
        headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
        payload: form({ namespace, key, value: "x" }),
      });
      expect(res.statusCode, `${namespace}.${key}`).toBe(400);
      expect(res.body).not.toContain("Something went wrong");
      await app.app.close();
    }
    // Never reached the database.
    expect(spy).not.toHaveBeenCalled();
  });

  it("declares a key with an empty value, storing null", async () => {
    // The shape that produced the 500: a valid name and a deliberately empty
    // value. The empty box was never the problem, but it is the path the
    // operator was on when they found the missing name check.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/development/add",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("admin") },
      payload: form({ namespace: "free-form", key: "scratch_key", value: "" }),
    });
    expect(res.statusCode).toBe(303);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ configKey: "scratch_key", value: null }),
      null,
      expect.anything(),
    );
    await app.app.close();
  });

  it("still demands the typed label AND a reason for a production secret", async () => {
    // Dropping the reason from routine edits must not have dropped it from
    // the ritual: these are the two shapes the ritual exists for.
    const spy = vi.fn(async () => APPLIED);
    const app = await buildApp({
      row: destination(),
      mutations: stubMutations(spy),
      project: PROJECT,
    });
    const res = await app.app.inject({
      method: "POST",
      url: "/admin/projects/storefront/config/production/set",
      headers: { ...FORM_HEADERS, cookie: sessionCookie("owner") },
      payload: form({
        namespace: "meta-capi",
        key: "access_token",
        value: "vault:polaris/production/meta",
        secret: "true",
        expected_updated_at: "",
        confirm: "meta-capi.access_token",
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("at least 10 characters");
    expect(spy).not.toHaveBeenCalled();
    await app.app.close();
  });
});
