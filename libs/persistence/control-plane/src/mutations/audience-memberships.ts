/**
 * The audience runner's window into membership state.
 *
 * Narrow for the same reason `profile-traits.ts` is narrow: this is a
 * scheduled batch writer, and the smaller the set of columns it can reach,
 * the smaller the set of things a bad run can break. It writes
 * `audience_memberships` and nothing else — it cannot touch a profile, an
 * identifier, or a trait.
 *
 * ## Re-entry reopens the row it closed
 *
 * `enter` is an upsert, not an insert. A profile that left and came back
 * gets its existing row reopened — `exited_at` cleared, `entered_at` reset
 * to now — rather than a second row.
 *
 * One row per `(scope, audience, profile)` is what makes "is this profile
 * a member" a primary-key lookup. The alternative, a row per membership
 * period, turns that question into a scan with an ordering and a
 * tie-break, and every reader has to get the same answer for the platform
 * to be coherent. The period history that shape would give is already on
 * the spine, where an unbounded append belongs.
 *
 * ## `entered_at` moves on re-entry; `restamp` must not move it
 *
 * A reopened membership genuinely starts now. But a row that is merely
 * being restamped after a version bump is the SAME membership, and moving
 * its start would corrupt the dwell time `audience.exited` reports later.
 * That is why they are two functions and not one with a flag.
 */

import type { Database } from "@polaris/persistence-postgres";
import { type Kysely, sql } from "kysely";

/** One stored membership row, as the diff reads it. */
export interface AudienceMembershipRow {
  readonly profileId: string;
  readonly enteredAt: Date;
  readonly exitedAt: Date | null;
  readonly audienceVersion: number;
}

export interface AudienceScope {
  readonly projectId: string;
  readonly environment: string;
  readonly audience: string;
}

/**
 * Every stored row for one audience in one scope — open AND closed.
 *
 * Closed rows are needed for the diff to tell a re-entry from a first
 * entry, so this deliberately does not filter on `exited_at IS NULL`. The
 * partial index serves the open-only reads that `polaris audiences show`
 * makes.
 */
export async function listAudienceMemberships(
  db: Kysely<Database>,
  scope: AudienceScope,
): Promise<readonly AudienceMembershipRow[]> {
  const rows = await db
    .selectFrom("audience_memberships")
    .select(["profile_id", "entered_at", "exited_at", "audience_version"])
    .where("project_id", "=", scope.projectId)
    .where("environment", "=", scope.environment)
    .where("audience", "=", scope.audience)
    .execute();

  return rows.map((row) => ({
    profileId: row.profile_id,
    enteredAt: row.entered_at,
    exitedAt: row.exited_at,
    audienceVersion: row.audience_version,
  }));
}

/** Open memberships only, for the read-side commands. */
export async function listOpenAudienceMemberships(
  db: Kysely<Database>,
  scope: AudienceScope,
  limit: number,
): Promise<readonly AudienceMembershipRow[]> {
  const rows = await db
    .selectFrom("audience_memberships")
    .select(["profile_id", "entered_at", "exited_at", "audience_version"])
    .where("project_id", "=", scope.projectId)
    .where("environment", "=", scope.environment)
    .where("audience", "=", scope.audience)
    .where("exited_at", "is", null)
    .orderBy("entered_at", "desc")
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    profileId: row.profile_id,
    enteredAt: row.entered_at,
    exitedAt: row.exited_at,
    audienceVersion: row.audience_version,
  }));
}

/** How many profiles are currently in an audience. */
export async function countOpenAudienceMemberships(
  db: Kysely<Database>,
  scope: AudienceScope,
): Promise<number> {
  const row = await db
    .selectFrom("audience_memberships")
    .select((eb) => eb.fn.countAll<string>().as("members"))
    .where("project_id", "=", scope.projectId)
    .where("environment", "=", scope.environment)
    .where("audience", "=", scope.audience)
    .where("exited_at", "is", null)
    .executeTakeFirst();
  return Number(row?.members ?? 0);
}

/**
 * Open a membership. Upsert: a returning profile reopens its closed row.
 *
 * Returns the row's `entered_at` so the caller can report it without a
 * second read.
 */
export async function enterAudience(
  db: Kysely<Database>,
  input: AudienceScope & {
    readonly audienceVersion: number;
    readonly profileId: string;
  },
): Promise<{ readonly enteredAt: Date }> {
  const row = await db
    .insertInto("audience_memberships")
    .values({
      project_id: input.projectId,
      environment: input.environment,
      audience: input.audience,
      audience_version: input.audienceVersion,
      profile_id: input.profileId,
      entered_at: sql<Date>`now()`,
      exited_at: null,
      updated_at: sql<Date>`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["project_id", "environment", "audience", "profile_id"]).doUpdateSet({
        // A re-entry is a NEW membership: the clock restarts.
        entered_at: sql<Date>`now()`,
        exited_at: null,
        audience_version: input.audienceVersion,
        updated_at: sql<Date>`now()`,
      }),
    )
    .returning("entered_at")
    .executeTakeFirstOrThrow();

  return { enteredAt: row.entered_at };
}

/**
 * Close an open membership.
 *
 * Guarded on `exited_at IS NULL` so a re-run cannot move an exit timestamp
 * that already exists — the runner should never ask, but a closed row
 * whose exit time drifted would silently corrupt the dwell time already
 * reported on the spine.
 */
export async function exitAudience(
  db: Kysely<Database>,
  input: AudienceScope & {
    readonly audienceVersion: number;
    readonly profileId: string;
  },
): Promise<void> {
  await db
    .updateTable("audience_memberships")
    .set({
      exited_at: sql<Date>`now()`,
      audience_version: input.audienceVersion,
      updated_at: sql<Date>`now()`,
    })
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment)
    .where("audience", "=", input.audience)
    .where("profile_id", "=", input.profileId)
    .where("exited_at", "is", null)
    .execute();
}

/**
 * Update the definition-version stamp on continuing members.
 *
 * Touches `audience_version` and `updated_at` only. `entered_at` is
 * deliberately absent from the SET: these rows are the same membership,
 * and moving their start would corrupt the dwell time reported when they
 * eventually close.
 */
export async function restampAudienceMemberships(
  db: Kysely<Database>,
  input: AudienceScope & {
    readonly audienceVersion: number;
    readonly profileIds: readonly string[];
  },
): Promise<void> {
  if (input.profileIds.length === 0) return;

  await db
    .updateTable("audience_memberships")
    .set({
      audience_version: input.audienceVersion,
      updated_at: sql<Date>`now()`,
    })
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment)
    .where("audience", "=", input.audience)
    .where("profile_id", "in", [...input.profileIds])
    .where("exited_at", "is", null)
    .execute();
}
