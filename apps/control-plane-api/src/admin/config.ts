/**
 * Admin UI runtime config.
 *
 * The panel is the operator surface, so it is always mounted — there is no
 * enable flag to forget. What varies by environment is how strict the
 * settings are:
 *
 *   local / development   dev defaults matching the Idp dev seed, so
 *                         `make dev` needs no env at all
 *   staging / production  the two secrets are required and a dev value is
 *                         refused, at boot rather than at first sign-in
 *
 * That asymmetry is the whole design here. A half-configured admin panel that
 * only breaks when someone tries to sign in is worse than a service that
 * refuses to start, but demanding config on a laptop to see a read-only page
 * is friction for nothing.
 *
 * Defaults match `~/src/idp/db/seeds/development/oauth_applications.rb`
 * (client `polaris_development`, secret `polaris_dev_secret`, redirect
 * `http://localhost:4001/admin/auth/callback`).
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 */

import {
  booleanFromStringSchema,
  durationMsSchema,
  nonEmptyStringSchema,
  positiveIntSchema,
} from "@polaris/shared-config";
import { z } from "zod";

import { PLATFORM_ROLE_RANK, type PlatformRoleName } from "./platform-role.js";

/**
 * Minimum platform role the UI admits at all. Not configurable: below admin
 * there is no read-only tier to grant. The admin surface is entirely
 * privileged — API keys, destination state, DLQ triage — so `member` and
 * `viewer` are denied exactly like `none`.
 */
export const MINIMUM_PLATFORM_ROLE = "admin" as const satisfies PlatformRoleName;

export interface AdminConfig {
  /** `Secure` attribute on every admin cookie. False only for local http. */
  readonly cookieSecure: boolean;
  /** HMAC seed for the signed identity cookie. */
  readonly sessionSecret: string;
  /** Row cap on every list page. */
  readonly pageSize: number;
  /**
   * Minimum role for mutating a row whose `environment` is `production`.
   *
   * The production-mutation gate in `../auth/gate.ts` cannot help here: it
   * refuses only actors whose source is not `declared`, and every
   * Idp-authenticated admin resolves to `declared` by construction. So the UI
   * brings its own escalation, and it costs almost nothing because Idp
   * already ranks owner > admin > member > viewer > none.
   *
   * Set to `admin` to disable the distinction.
   */
  readonly productionMinRole: PlatformRoleName;
  readonly idp: AdminIdpConfig;
}

export interface AdminIdpConfig {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly endSessionEndpoint: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly authorizeUrl: string;
  /** Timeout for every server-to-server call to Idp. */
  readonly requestTimeoutMs: number;
}

const roleNameSchema = z.enum(
  Object.keys(PLATFORM_ROLE_RANK) as [PlatformRoleName, ...PlatformRoleName[]],
);

/**
 * Dev-only defaults, matching the Idp development seed.
 *
 * Both are refused outright in staging and production — see the superRefine
 * below. They exist so a laptop needs no configuration, not as a fallback
 * anything real should ever reach.
 */
const DEV_SESSION_SECRET = "polaris-admin-dev-session-secret-not-for-real-use" as const;
const DEV_CLIENT_SECRET = "polaris_dev_secret" as const;

/** Environments where a dev default is a bug rather than a convenience. */
const STRICT_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);

const rawAdminEnvSchema = z.object({
  // Read directly rather than through serviceEnvSchema: this block is parsed
  // against the whole env object, and only needs the one value.
  POLARIS_ENV: z.string().default("local"),
  POLARIS_ADMIN_COOKIE_SECURE: booleanFromStringSchema.optional(),
  POLARIS_ADMIN_SESSION_SECRET: z.string().optional(),
  POLARIS_ADMIN_PAGE_SIZE: positiveIntSchema.max(1000).default(50),
  POLARIS_ADMIN_PRODUCTION_MIN_ROLE: roleNameSchema.default("owner"),
  IDP_BASE_URL: nonEmptyStringSchema.default("http://localhost:3011"),
  IDP_ISSUER: z.string().optional(),
  IDP_JWKS_URL: z.string().optional(),
  IDP_CLIENT_ID: nonEmptyStringSchema.default("polaris_development"),
  IDP_CLIENT_SECRET: z.string().optional(),
  IDP_REDIRECT_URI: z.string().optional(),
  IDP_END_SESSION_ENDPOINT: z.string().optional(),
  IDP_REQUEST_TIMEOUT_MS: durationMsSchema.default(10_000),
});

/**
 * Parse the admin block out of the process env.
 *
 * Always produces a config — the panel is not optional. In staging and
 * production the two secrets must be set to real values, and failing that is
 * a boot failure, which is where a misconfiguration should surface.
 */
export const adminEnvSchema = rawAdminEnvSchema
  .superRefine((parsed, ctx) => {
    if (!STRICT_ENVIRONMENTS.has(parsed.POLARIS_ENV)) return;

    // This secret signs the identity cookie, which is what stops a client
    // forging the email that lands in audit_records.actor_label. A weak or
    // shared-with-the-repo value is a broken audit trail, not a warning.
    const secret = parsed.POLARIS_ADMIN_SESSION_SECRET ?? "";
    if (secret.length < 32 || secret === DEV_SESSION_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_ADMIN_SESSION_SECRET"],
        message: `must be set to at least 32 characters in ${parsed.POLARIS_ENV} (it signs the admin identity cookie); the development default is refused here`,
      });
    }

    const clientSecret = parsed.IDP_CLIENT_SECRET ?? "";
    if (clientSecret.length === 0 || clientSecret === DEV_CLIENT_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["IDP_CLIENT_SECRET"],
        message: `must be set to this environment's Idp client secret in ${parsed.POLARIS_ENV}; the development default is refused here`,
      });
    }
  })
  .transform((parsed): AdminConfig => {
    const baseUrl = stripTrailingSlash(parsed.IDP_BASE_URL);
    const issuer = stripTrailingSlash(parsed.IDP_ISSUER ?? baseUrl);
    const isLocal = parsed.POLARIS_ENV === "local";
    return {
      // Local development is plain http, so a Secure cookie would never be
      // sent and every sign-in would loop. Everywhere else it is on unless
      // explicitly disabled.
      cookieSecure: parsed.POLARIS_ADMIN_COOKIE_SECURE ?? !isLocal,
      sessionSecret: parsed.POLARIS_ADMIN_SESSION_SECRET ?? DEV_SESSION_SECRET,
      pageSize: parsed.POLARIS_ADMIN_PAGE_SIZE,
      productionMinRole: parsed.POLARIS_ADMIN_PRODUCTION_MIN_ROLE,
      idp: {
        baseUrl,
        issuer,
        jwksUrl: parsed.IDP_JWKS_URL ?? `${baseUrl}/.well-known/jwks.json`,
        clientId: parsed.IDP_CLIENT_ID,
        clientSecret: parsed.IDP_CLIENT_SECRET ?? DEV_CLIENT_SECRET,
        // Must match a registered redirect_uri byte-for-byte: Idp compares by
        // exact string membership, not prefix, and a mismatch 400s at
        // /oauth/authorize before any redirect happens.
        redirectUri: parsed.IDP_REDIRECT_URI ?? "http://localhost:4001/admin/auth/callback",
        endSessionEndpoint: parsed.IDP_END_SESSION_ENDPOINT ?? `${baseUrl}/oauth/end_session`,
        tokenUrl: `${baseUrl}/oauth/token`,
        revokeUrl: `${baseUrl}/oauth/revoke`,
        authorizeUrl: `${baseUrl}/oauth/authorize`,
        requestTimeoutMs: parsed.IDP_REQUEST_TIMEOUT_MS,
      },
    };
  });

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
