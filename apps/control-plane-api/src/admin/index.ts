/**
 * Admin UI entry point.
 *
 * `app.ts` imports exactly this function and nothing else from `admin/`, so
 * the whole surface is one call that either happens or does not.
 *
 * `registerAdminUi` keeps the repo's `registerXRoutes(app, deps)` convention
 * on the outside while using `app.register` on the inside — see
 * `plugin.ts` for why encapsulation is load-bearing here rather than
 * stylistic.
 */

import type { Database } from "@polaris/shared-db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

import { type AdminMutations, createKyselyAdminMutations } from "./actions/mutations.js";
import type { AdminConfig } from "./config.js";
import { createIdpAuth, type IdpAuth } from "./idp-auth.js";
import type { IdpOAuthClient } from "./idp-proxy.js";
import { createAdminPlugin } from "./plugin.js";
import { type AdminQueries, createKyselyAdminQueries } from "./queries.js";
import type { SessionRefresher } from "./refresh.js";
import { ADMIN_PREFIX } from "./session.js";

export interface RegisterAdminUiOptions {
  readonly config: AdminConfig;
  /** Service environment, rendered in the header chrome. */
  readonly environment: string;
  /** Production wiring. Ignored when `queries` is supplied. */
  readonly db?: Kysely<Database> | undefined;
  /** Test seam: fixture-backed reads, no Postgres. */
  readonly queries?: AdminQueries | undefined;
  /** Test seam: stubbed verification, no live Idp and no signing key. */
  readonly idpAuth?: IdpAuth | undefined;
  /** Test seam: stubbed OAuth flow, no live Idp. */
  readonly idpClient?: IdpOAuthClient | undefined;
  /** Test seam: stubbed refresh-token redemption, no live Idp. */
  readonly refresher?: SessionRefresher | undefined;
  /**
   * Audited writes. Built from `db` when absent; pass `null` for an
   * explicitly read-only panel, in which case the mutation routes are never
   * registered.
   */
  readonly mutations?: AdminMutations | null | undefined;
}

export async function registerAdminUi(
  app: FastifyInstance,
  options: RegisterAdminUiOptions,
): Promise<void> {
  const queries = options.queries ?? buildQueries(options.db);
  const idpAuth = options.idpAuth ?? createIdpAuth(options.config.idp);
  // `undefined` means "build it"; `null` means "read-only, on purpose".
  const mutations =
    options.mutations === null
      ? undefined
      : (options.mutations ??
        (options.db !== undefined ? createKyselyAdminMutations(options.db) : undefined));

  await app.register(
    createAdminPlugin({
      config: options.config,
      queries,
      idpAuth,
      environment: options.environment,
      ...(options.idpClient !== undefined ? { idpClient: options.idpClient } : {}),
      ...(options.refresher !== undefined ? { refresher: options.refresher } : {}),
      ...(mutations !== undefined ? { mutations } : {}),
    }),
    { prefix: ADMIN_PREFIX },
  );
}

function buildQueries(db: Kysely<Database> | undefined): AdminQueries {
  if (db === undefined) {
    throw new Error(
      "registerAdminUi: pass `db` or `queries`. The admin UI cannot read control-plane state without one.",
    );
  }
  return createKyselyAdminQueries(db);
}

export type { AdminActor, AdminMutations, MutationOutcome } from "./actions/mutations.js";
export { type AdminConfig, adminEnvSchema, MINIMUM_PLATFORM_ROLE } from "./config.js";
export type { AdminContext } from "./guard.js";
export type { IdpAuth, IdTokenClaims } from "./idp-auth.js";
export type { IdpOAuthClient, IdpTokenResponse } from "./idp-proxy.js";
export {
  type PlatformRoleName,
  platformRoleAtLeast,
  resolvePlatformRole,
} from "./platform-role.js";
export type {
  AdminQueries,
  ApiKeyRow,
  AuditRow,
  DestinationRow,
  DlqRow,
  OverviewCounts,
  ProcessorActivationRow,
  ProjectRow,
  SourceRow,
} from "./queries.js";
export { createSessionRefresher, type SessionRefresher, wrapSingleFlight } from "./refresh.js";
