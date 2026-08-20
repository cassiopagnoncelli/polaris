/**
 * Read-only profile access for the traits enricher.
 *
 * The whole point of this module is what it CANNOT do. The identity
 * stage is the profile store's only sync-path writer; the enrichment
 * stage reads. That ownership line is enforced here by construction
 * rather than by review: the port exposes one method, it returns a
 * snapshot, and there is no insert, update or transaction anywhere in
 * the package. A future contributor who wants the enrichment stage to
 * write a profile has to add a dependency and a method, which is a
 * conversation, not a slip.
 *
 * ## The read needs no read-your-writes machinery
 *
 * The identity stage commits its transaction BEFORE publishing to
 * `identified.events` (`sync/identity/resolver/v1/src/runtime.ts` states
 * the invariant). By the time this stage sees an event carrying a
 * `profile_id`, the row it names is committed and visible to any
 * connection. No retry loop, no replica-lag guard, no "wait for the
 * profile to appear" — the ordering was bought upstream, and adding
 * machinery here would only hide a violation of it.
 *
 * A miss is therefore a real fact, not a race: the profile was deleted,
 * or the event was replayed from an archive older than the store.
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

/** A committed profile, as the enricher needs it. */
export interface ProfileSnapshot {
  readonly traits: Record<string, unknown>;
  /** Monotonic per profile; `bigint` in Postgres, so it arrives as a string. */
  readonly traitsVersion: number;
}

/** The one read this stage is allowed to perform. */
export interface ProfileReader {
  /** The committed profile, or `null` when no row bears that id. */
  readProfile(profileId: string): Promise<ProfileSnapshot | null>;
}

/**
 * Kysely-backed reader.
 *
 * `selectFrom("profiles")` with three columns and no lock: this is a
 * point read on the primary key, on the hot path of every event that
 * resolved to a person. Taking a row lock here would serialise the
 * embarrassingly-parallel half of the spine against the identity
 * stage's writes for no benefit — a snapshot read of committed state is
 * exactly what "latest as of delivery" means.
 */
export function createKyselyProfileReader(db: Kysely<Database>): ProfileReader {
  return {
    async readProfile(profileId: string): Promise<ProfileSnapshot | null> {
      const row = await db
        .selectFrom("profiles")
        .select(["traits", "traits_version", "merged_into"])
        .where("profile_id", "=", profileId)
        .executeTakeFirst();

      if (row === undefined) return null;
      // `merged_into` is audit-only: the identity stage repoints
      // identifiers eagerly, so a losing profile's id never reaches the
      // spine on a fresh event. It can still arrive on a REPLAY of
      // events published before the merge, and the honest answer then is
      // the traits of the row that was named — reading through to the
      // winner would silently rewrite history the replay is meant to
      // reproduce.
      return {
        traits: (row.traits as Record<string, unknown> | null) ?? {},
        traitsVersion: Number(row.traits_version ?? 0),
      };
    },
  };
}
