/**
 * Admin config tests.
 *
 * The panel is always mounted, so the only thing that varies is how strict
 * the settings are. These cases pin both halves of that: a laptop needs no
 * configuration, and staging or production refuses to boot on a development
 * secret rather than running with one.
 */

import { describe, expect, it } from "vitest";

import { adminEnvSchema } from "../src/admin/config.js";

const REAL_SECRETS = {
  POLARIS_ADMIN_SESSION_SECRET: "r".repeat(48),
  IDP_CLIENT_SECRET: "a-real-client-secret-from-the-vault",
};

describe("admin config — development ergonomics", () => {
  it("needs no configuration at all on a laptop", () => {
    const config = adminEnvSchema.parse({});

    expect(config.idp.clientId).toBe("polaris_development");
    expect(config.idp.baseUrl).toBe("http://localhost:3011");
    expect(config.idp.redirectUri).toBe("http://localhost:4001/admin/auth/callback");
    expect(config.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.productionMinRole).toBe("owner");
  });

  it("matches the Idp development seed, so the local flow works out of the box", () => {
    // ~/src/idp/db/seeds/development/oauth_applications.rb, app_polaris.
    const config = adminEnvSchema.parse({});
    expect(config.idp.clientId).toBe("polaris_development");
    expect(config.idp.clientSecret).toBe("polaris_dev_secret");
    // Registered byte-for-byte there: Idp matches redirect_uri by exact
    // string membership, not prefix.
    expect(config.idp.redirectUri).toBe("http://localhost:4001/admin/auth/callback");
  });

  it("leaves cookies non-Secure on local http, so sign-in does not loop", () => {
    // A Secure cookie is never sent over plain http, so every callback would
    // set a session the next request cannot see.
    expect(adminEnvSchema.parse({ POLARIS_ENV: "local" }).cookieSecure).toBe(false);
  });

  it("turns Secure on everywhere else", () => {
    for (const env of ["development", "staging", "production"]) {
      const parsed = adminEnvSchema.parse({ POLARIS_ENV: env, ...REAL_SECRETS });
      expect([env, parsed.cookieSecure]).toEqual([env, true]);
    }
  });

  it("still allows an explicit override in both directions", () => {
    expect(
      adminEnvSchema.parse({ POLARIS_ENV: "local", POLARIS_ADMIN_COOKIE_SECURE: "true" })
        .cookieSecure,
    ).toBe(true);
    expect(
      adminEnvSchema.parse({
        POLARIS_ENV: "production",
        POLARIS_ADMIN_COOKIE_SECURE: "false",
        ...REAL_SECRETS,
      }).cookieSecure,
    ).toBe(false);
  });

  it("derives the Idp endpoints from one base url", () => {
    const config = adminEnvSchema.parse({ IDP_BASE_URL: "https://account.example.com/" });
    expect(config.idp.issuer).toBe("https://account.example.com");
    expect(config.idp.jwksUrl).toBe("https://account.example.com/.well-known/jwks.json");
    expect(config.idp.tokenUrl).toBe("https://account.example.com/oauth/token");
    expect(config.idp.authorizeUrl).toBe("https://account.example.com/oauth/authorize");
    expect(config.idp.revokeUrl).toBe("https://account.example.com/oauth/revoke");
    expect(config.idp.endSessionEndpoint).toBe("https://account.example.com/oauth/end_session");
  });
});

describe("admin config — staging and production strictness", () => {
  it.each(["staging", "production"])("refuses to boot in %s with no secrets", (env) => {
    expect(() => adminEnvSchema.parse({ POLARIS_ENV: env })).toThrow();
  });

  it.each(["staging", "production"])("refuses the development session secret in %s", (env) => {
    // The failure has to be at boot. A panel that only breaks when someone
    // signs in is worse than one that refuses to start.
    const result = adminEnvSchema.safeParse({
      POLARIS_ENV: env,
      POLARIS_ADMIN_SESSION_SECRET: "polaris-admin-dev-session-secret-not-for-real-use",
      IDP_CLIENT_SECRET: REAL_SECRETS.IDP_CLIENT_SECRET,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("POLARIS_ADMIN_SESSION_SECRET");
  });

  it.each(["staging", "production"])("refuses the development client secret in %s", (env) => {
    const result = adminEnvSchema.safeParse({
      POLARIS_ENV: env,
      POLARIS_ADMIN_SESSION_SECRET: REAL_SECRETS.POLARIS_ADMIN_SESSION_SECRET,
      IDP_CLIENT_SECRET: "polaris_dev_secret",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("IDP_CLIENT_SECRET");
  });

  it("refuses a session secret that is merely short", () => {
    const result = adminEnvSchema.safeParse({
      POLARIS_ENV: "production",
      POLARIS_ADMIN_SESSION_SECRET: "too-short",
      IDP_CLIENT_SECRET: REAL_SECRETS.IDP_CLIENT_SECRET,
    });
    expect(result.success).toBe(false);
  });

  it("accepts real secrets", () => {
    const config = adminEnvSchema.parse({ POLARIS_ENV: "production", ...REAL_SECRETS });
    expect(config.sessionSecret).toBe(REAL_SECRETS.POLARIS_ADMIN_SESSION_SECRET);
    expect(config.idp.clientSecret).toBe(REAL_SECRETS.IDP_CLIENT_SECRET);
  });

  it("does not apply the strictness to development, which is not a real deployment", () => {
    expect(() => adminEnvSchema.parse({ POLARIS_ENV: "development" })).not.toThrow();
  });
});

describe("admin config — production mutation role", () => {
  it("defaults to owner, escalating above the admin entry bar", () => {
    expect(adminEnvSchema.parse({}).productionMinRole).toBe("owner");
  });

  it("can be lowered to admin to disable the distinction", () => {
    expect(
      adminEnvSchema.parse({ POLARIS_ADMIN_PRODUCTION_MIN_ROLE: "admin" }).productionMinRole,
    ).toBe("admin");
  });

  it("rejects a role outside the Idp vocabulary", () => {
    expect(() =>
      adminEnvSchema.parse({ POLARIS_ADMIN_PRODUCTION_MIN_ROLE: "superuser" }),
    ).toThrow();
  });
});
