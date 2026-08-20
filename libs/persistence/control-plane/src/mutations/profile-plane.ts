/**
 * Truncate one project's profile plane.
 *
 * The destructive half of `polaris profiles rebuild`. Everything Polaris
 * concluded about who is who, for one `(project_id, environment)`, is
 * deleted so the resolver can conclude it again from the events.
 *
 * This is the most dangerous mutation in the control plane, and the two
 * things that make it safe are not in this file: the CLI refuses production
 * without an operator token, and it refuses entirely without `--yes`. What
 * IS here is the ordering, the scoping, and the audit row.
 *
 * ## Order is dictated by foreign keys, not preference
 *
 * None of the profile-plane tables declare `ON DELETE CASCADE` — deliberately,
 * per the migration that created them: a cascade would let a stray delete
 * anywhere take the plane with it. So children go before parents:
 *
 *   1. `profile_merges`      references profiles TWICE (winner and loser)
 *   2. `profile_identifiers` references profiles
 *   3. `identity_links`      the evidence ledger, scoped by project directly
 *   4. `profiles`            last, and see below
 *
 * `profiles.merged_into` is a self-reference, so deleting the set in one
 * statement would still trip the constraint row-by-row — Postgres checks
 * immediately unless the constraint is deferrable, and this one is not. The
 * self-reference is therefore NULLed first. That update is part of the same
 * transaction, so a failure anywhere leaves the plane exactly as it was.
 *
 * ## One transaction, always
 *
 * A partial truncate is the worst outcome available here: identifiers
 * pointing at profiles that no longer exist, or merges referencing both. The
 * whole thing commits or none of it does.
 *
 * ## What this does NOT touch
 *
 * `raw.events` — the source the rebuild replays FROM. Deleting the plane and
 * the events would not be a rebuild, it would be a deletion.
 *
 * ClickHouse — history is never rewritten (see
 * `docs/architecture/07-clickhouse.md`). Rows written under the old profile
 * ids stay, and the runbook is explicit that queries spanning a rebuild
 * boundary see the same person under two ids. That is a consequence of the
 * design, not an oversight this mutation should paper over.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import type { AuditContext, MutationOutcome } from "./audited.js";
import { withAudit } from "./audited.js";

/** Row counts removed, per table. Recorded on the audit row and returned. */
export interface ProfilePlaneTruncateCounts {
  readonly profiles: number;
  readonly profile_identifiers: number;
  readonly profile_merges: number;
  readonly identity_links: number;
}

export interface TruncateProfilePlaneInput {
  readonly projectId: string;
  readonly environment: string;
}

/**
 * Delete every profile-plane row for one project and environment.
 *
 * Returns the per-table counts so the caller can report what it removed —
 * an operator who runs a rebuild and is told "done" learns nothing about
 * whether it did what they expected.
 */
export async function truncateProfilePlaneWithAudit(
  db: Kysely<Database>,
  input: TruncateProfilePlaneInput,
  audit: AuditContext,
): Promise<MutationOutcome & { readonly counts: ProfilePlaneTruncateCounts }> {
  let counts: ProfilePlaneTruncateCounts = {
    profiles: 0,
    profile_identifiers: 0,
    profile_merges: 0,
    identity_links: 0,
  };

  const outcome = await withAudit(
    db,
    audit,
    {
      action: "profiles.truncate",
      targetType: "project",
      targetId: input.projectId,
      projectId: input.projectId,
      environment: input.environment as never,
      before: { project_id: input.projectId, environment: input.environment },
      after: { project_id: input.projectId, environment: input.environment, truncated: true },
    },
    async (trx) => {
      // Written out per table rather than through a generic helper. Kysely's
      // builder overloads do not unify across table names, and on a delete
      // path that empties a project's identity a reader should be able to
      // see each statement rather than infer it.

      // 1. Merges first: they reference profiles from both sides. Scoped
      //    through the winner, which shares the losing profile's project by
      //    construction — a merge across projects is not representable.
      const merges = await trx
        .deleteFrom("profile_merges")
        .where((eb) =>
          eb(
            "winner_profile_id",
            "in",
            eb
              .selectFrom("profiles")
              .select("profile_id")
              .where("project_id", "=", input.projectId)
              .where("environment", "=", input.environment),
          ),
        )
        .executeTakeFirst();

      // 2. Identifiers.
      const identifiers = await trx
        .deleteFrom("profile_identifiers")
        .where("project_id", "=", input.projectId)
        .where("environment", "=", input.environment)
        .executeTakeFirst();

      // 3. The evidence ledger.
      const links = await trx
        .deleteFrom("identity_links")
        .where("project_id", "=", input.projectId)
        .where("environment", "=", input.environment)
        .executeTakeFirst();

      // 4. Break the self-reference before deleting, or `merged_into` trips
      //    row-by-row. Same transaction, so this is never observable.
      await trx
        .updateTable("profiles")
        .set({ merged_into: null })
        .where("project_id", "=", input.projectId)
        .where("environment", "=", input.environment)
        .execute();

      const profiles = await trx
        .deleteFrom("profiles")
        .where("project_id", "=", input.projectId)
        .where("environment", "=", input.environment)
        .executeTakeFirst();

      counts = {
        profiles: Number(profiles.numDeletedRows ?? 0),
        profile_identifiers: Number(identifiers.numDeletedRows ?? 0),
        profile_merges: Number(merges.numDeletedRows ?? 0),
        identity_links: Number(links.numDeletedRows ?? 0),
      };
      // `true` even when every count is zero. A rebuild of a project with no
      // profiles yet is a legitimate no-op, not a failure, and reporting it
      // as un-applied would make the CLI stop before the replay.
      return true;
    },
  );

  return { ...outcome, counts };
}
