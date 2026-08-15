/**
 * The async trait writer's window into the profile store.
 *
 * Deliberately narrow, and the narrowness IS the design. The plan's
 * ownership line says the identity stage is the profile store's only SYNC
 * writer; this card amended it to allow async trait computation to write
 * `traits` and `traits_version` — and nothing else.
 *
 * The rule exists so ONE writer decides who someone is: identifiers, merges,
 * canonical customer id. Two deciders there produce split or wrongly-merged
 * profiles, which is the race the resolver's advisory locks close. Traits are
 * a disjoint column set, so a batch writer touching them cannot cause an
 * identity split — but only if it genuinely cannot touch the rest, which is
 * why this module exposes two functions rather than a general update.
 *
 * ## The version bump is inside the same statement
 *
 * `traits_version` increments in the UPDATE that writes the traits, not in a
 * read-modify-write around it. Two runs overlapping — a cron and a manual
 * invocation — would otherwise both read version N and both write N+1,
 * leaving two different trait sets claiming the same version. A consumer
 * comparing versions would then miss one of them entirely.
 */

import type { Database } from "@polaris/shared-db";
import { type Kysely, sql } from "kysely";

/** A profile's current traits, for the diff. */
export interface ProfileTraitsRow {
  readonly profileId: string;
  readonly traits: Readonly<Record<string, unknown>>;
}

/**
 * Every profile in scope carrying at least one of `keys`.
 *
 * Scoped to the keys being recomputed rather than the whole project: the
 * diff needs profiles that hold a value for a trait under computation, plus
 * whoever the definition's query returned. A project-wide read would pull
 * every profile to answer a question about a handful.
 */
export async function findProfilesWithTraits(
  db: Kysely<Database>,
  input: {
    readonly projectId: string;
    readonly environment: string;
    readonly keys: readonly string[];
  },
): Promise<readonly ProfileTraitsRow[]> {
  if (input.keys.length === 0) return [];

  const rows = await db
    .selectFrom("profiles")
    .select(["profile_id", "traits"])
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment)
    // `?|` is "has any of these keys". Postgres can use a GIN index on the
    // jsonb for it, where a scan of every profile's traits could not.
    .where(sql<boolean>`traits ?| ${sql.val(input.keys)}`)
    .execute();

  return rows.map((row) => ({
    profileId: row.profile_id,
    traits: (row.traits ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Apply one profile's trait changes and return its new version.
 *
 * Set keys are merged, removed keys are deleted, and `traits_version`
 * increments — all in one statement, so overlapping runs cannot both claim
 * the same version. Returns `null` when the profile no longer exists: a
 * rebuild or a merge can retire a profile between the diff and the write,
 * and that is not an error worth failing a whole run for.
 */
export async function applyProfileTraitChange(
  db: Kysely<Database>,
  input: {
    readonly projectId: string;
    readonly environment: string;
    readonly profileId: string;
    readonly set: Readonly<Record<string, unknown>>;
    readonly remove: readonly string[];
  },
): Promise<{ readonly traitsVersion: number } | null> {
  // `-` removes keys, `||` merges. Applied in that order so a key that is
  // both removed and set — which the diff never produces, but a future
  // caller might — ends up SET rather than absent.
  const removed =
    input.remove.length > 0 ? sql`(traits - ${sql.val(input.remove)}::text[])` : sql`traits`;
  const merged = sql`${removed} || ${sql.val(JSON.stringify(input.set))}::jsonb`;

  const row = await db
    .updateTable("profiles")
    .set({
      traits: sql<Record<string, unknown>>`${merged}`,
      // In the same statement as the write. A read-modify-write here would
      // let two overlapping runs both read N and both write N+1, leaving
      // two different trait sets claiming one version.
      traits_version: sql<string>`traits_version + 1`,
      updated_at: sql<Date>`now()`,
    })
    .where("profile_id", "=", input.profileId)
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment)
    .returning("traits_version")
    .executeTakeFirst();

  if (row === undefined) return null;
  return { traitsVersion: Number(row.traits_version) };
}
