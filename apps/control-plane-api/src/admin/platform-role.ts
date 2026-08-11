/**
 * Platform-role resolution and ranking.
 *
 * Ported from `haws/src/admin/platformRole.ts`, which solves the same problem
 * against the same Idp.
 *
 * The load-bearing detail is `resolvePlatformRole`'s first line. `Passport`'s
 * `platformRole` getter calls `requireUserToken()` internally, which **throws
 * `NotAUserTokenError`** on a client-credentials token rather than returning
 * null. A guard that reads the role without checking `passport.user` first
 * turns a service token presented to the admin UI into an uncaught 500
 * instead of a clean denial. Guard before touching — do not try/catch.
 *
 * That is also why nothing here uses `Passport.platformAdmin`, convenient as
 * it looks: it is the same throwing path one getter deeper.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 */

import type { Passport, PlatformRole } from "@polaris/idp";

/** The role names Idp emits, ranked. */
export const PLATFORM_ROLE_RANK = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
  none: 0,
} as const satisfies Record<PlatformRole, number>;

export type PlatformRoleName = keyof typeof PLATFORM_ROLE_RANK;

/**
 * The role this passport carries, or `none`.
 *
 * Service tokens (client_credentials, discriminated structurally by
 * `sub === client_id`) resolve to `none` — they are never admins, and asking
 * them for a role throws.
 */
export function resolvePlatformRole(passport: Passport): PlatformRoleName {
  if (!passport.user) return "none";
  return passport.platformRole ?? "none";
}

/** `role >= minimum` on the ranking above. */
export function platformRoleAtLeast(role: PlatformRoleName, minimum: PlatformRoleName): boolean {
  return PLATFORM_ROLE_RANK[role] >= PLATFORM_ROLE_RANK[minimum];
}
