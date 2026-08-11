/**
 * Admin UI runtime config.
 *
 * The admin UI is **off by default**. `POLARIS_ADMIN_UI_ENABLED` gates
 * registration entirely — when it is false the plugin is never registered and
 * `/admin/*` 404s through the standard Problem handler, so merging this
 * changes nothing in any deployed environment until someone opts in.
 *
 * When it IS enabled, the Idp settings become required and a missing one
 * fails at boot rather than at the first login attempt. That is the whole
 * reason for the `superRefine` below: a half-configured admin UI that only
 * breaks when an operator tries to sign in is worse than a service that
 * refuses to start.
 *
 * Defaults mirror the Idp dev seed (`~/src/idp/db/seeds/development/
 * oauth_applications.rb`, client `polaris_development`) so a local
 * `make dev-control-plane` needs only the enable flag and a session secret.
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
  readonly enabled: true;
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

const rawAdminEnvSchema = z.object({
  POLARIS_ADMIN_UI_ENABLED: booleanFromStringSchema.default(false),
  POLARIS_ADMIN_COOKIE_SECURE: booleanFromStringSchema.default(true),
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
 * Parses the admin block out of the process env.
 *
 * Returns `null` when the UI is disabled — the caller skips registration
 * entirely rather than registering routes that refuse every request.
 */
export const adminEnvSchema = rawAdminEnvSchema
  .superRefine((parsed, ctx) => {
    if (!parsed.POLARIS_ADMIN_UI_ENABLED) return;

    // The session secret signs the identity cookie, which is what stops a
    // client forging the email that lands in audit_records.actor_label.
    // A short one is not a warning, it is a broken audit trail.
    const secret = parsed.POLARIS_ADMIN_SESSION_SECRET ?? "";
    if (secret.length < 32) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_ADMIN_SESSION_SECRET"],
        message:
          "must be at least 32 characters when POLARIS_ADMIN_UI_ENABLED is true (it signs the admin identity cookie)",
      });
    }
    if ((parsed.IDP_CLIENT_SECRET ?? "").length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["IDP_CLIENT_SECRET"],
        message: "is required when POLARIS_ADMIN_UI_ENABLED is true",
      });
    }
  })
  .transform((parsed): AdminConfig | null => {
    if (!parsed.POLARIS_ADMIN_UI_ENABLED) return null;

    const baseUrl = stripTrailingSlash(parsed.IDP_BASE_URL);
    const issuer = stripTrailingSlash(parsed.IDP_ISSUER ?? baseUrl);
    return {
      enabled: true,
      cookieSecure: parsed.POLARIS_ADMIN_COOKIE_SECURE,
      sessionSecret: parsed.POLARIS_ADMIN_SESSION_SECRET ?? "",
      pageSize: parsed.POLARIS_ADMIN_PAGE_SIZE,
      productionMinRole: parsed.POLARIS_ADMIN_PRODUCTION_MIN_ROLE,
      idp: {
        baseUrl,
        issuer,
        jwksUrl: parsed.IDP_JWKS_URL ?? `${baseUrl}/.well-known/jwks.json`,
        clientId: parsed.IDP_CLIENT_ID,
        clientSecret: parsed.IDP_CLIENT_SECRET ?? "",
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
