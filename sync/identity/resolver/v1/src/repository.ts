/**
 * The PostgreSQL half of the profile store.
 *
 * What resolution MEANS — lock, look up, create / bind / merge, patch —
 * moved to `@polaris/identity-graph` when ADR-0007's third law was
 * applied to this stage: it is version-invariant physics, and a replay of
 * `resolver/v1` is a correctness contract because unmerge is
 * replay-rebuild. What is left here is the half that is genuinely about
 * Postgres, and it is the only half a new storage engine would rewrite.
 *
 * Two implementations of `IdentityGraphStore` exist: this one, and the
 * in-memory store in `test/fakes.ts`. They run the SAME decision
 * procedure — the fake is a store, not a second copy of the semantics —
 * which is what makes the golden fixtures evidence about production
 * behaviour rather than about the fake.
 *
 * ## One transaction per event
 *
 * `resolveProfile` opens the transaction and hands `resolveIdentity` a
 * store bound to it, so a resolution cannot half-commit. The caller
 * publishes only after it returns: commit-before-publish is the
 * invariant the enrichment stage depends on, and it is a decision made
 * in `runtime.ts`, once.
 */

import {
  type IdentityGraphStore,
  type LinkRecord,
  type MergeRecord,
  resolveIdentity,
} from "@polaris/identity-graph";
import type { StrongIdentityKind } from "@polaris/identity-rules";
import type { ProfileRepository, ResolutionResult, ResolveInput } from "@polaris/profiles";
import type { Database } from "@polaris/persistence-postgres";
import { type Kysely, sql, type Transaction } from "kysely";
import { v7 as uuidv7 } from "uuid";

import { PROCESSOR_NAME, PROCESSOR_VERSION } from "./emit.js";

export function createKyselyProfileRepository(db: Kysely<Database>): ProfileRepository {
  return {
    async resolveProfile(input: ResolveInput): Promise<ResolutionResult> {
      // An event with nothing to resolve never opens a transaction. The
      // decision procedure would return the same answer, but it would cost
      // a round trip per unidentifiable event on the spine's hot path.
      if (input.identifiers.length === 0) {
        return resolveIdentity(unreachableStore, input);
      }
      return db.transaction().execute(async (trx) => resolveIdentity(kyselyGraphStore(trx), input));
    },
  };
}

/**
 * A store for the one call that provably makes no store call.
 *
 * `resolveIdentity` returns the unidentified result before touching its
 * store when no identifiers survived collection, so this is never
 * reached. It exists so the zero-identifier short-circuit above is a
 * transaction decision rather than a duplicated copy of what
 * "unidentified" resolves to — two places computing that answer is
 * exactly the drift the carve-out removes.
 */
const unreachableStore = new Proxy({} as IdentityGraphStore, {
  get(_target, property): never {
    throw new Error(
      `identity graph store reached with no identifiers to resolve (${String(property)})`,
    );
  },
});

function kyselyGraphStore(trx: Transaction<Database>): IdentityGraphStore {
  return {
    newId: () => uuidv7(),

    async lockIdentifier(key: string): Promise<void> {
      // Transaction-scoped (`_xact_`), so it releases on commit or abort
      // with no unlock path to forget. Costs one round trip per identifier
      // — at most two in v1 — against a lock table in shared memory. A
      // hash collision between two unrelated identifiers costs a needless
      // wait and nothing else.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
    },

    async findBindings(scope, identifiers) {
      const rows = await trx
        .selectFrom("profile_identifiers")
        .select(["kind", "value", "profile_id"])
        .where("project_id", "=", scope.projectId)
        .where("environment", "=", scope.environment)
        .where((eb) =>
          eb.or(
            identifiers.map((identifier) =>
              eb.and([eb("kind", "=", identifier.kind), eb("value", "=", identifier.value)]),
            ),
          ),
        )
        .forUpdate()
        .execute();
      return rows.map((row) => ({
        kind: row.kind as StrongIdentityKind,
        value: row.value,
        profileId: row.profile_id,
      }));
    },

    async loadProfiles(profileIds) {
      if (profileIds.length === 0) return [];
      const rows = await trx
        .selectFrom("profiles")
        .select([
          "profile_id",
          "canonical_customer_id",
          "traits",
          "traits_version",
          "first_seen_at",
        ])
        .where("profile_id", "in", [...profileIds])
        .forUpdate()
        .execute();
      return rows.map((row) => ({
        profileId: row.profile_id,
        canonicalCustomerId: row.canonical_customer_id,
        traits: row.traits,
        // `traits_version` is a bigint, which the driver hands back as a
        // string; the graph counts in numbers.
        traitsVersion: Number(row.traits_version ?? 0),
        firstSeenAt: new Date(row.first_seen_at),
      }));
    },

    async insertProfile(input): Promise<void> {
      await trx
        .insertInto("profiles")
        .values({
          profile_id: input.profileId,
          project_id: input.scope.projectId,
          environment: input.scope.environment,
          canonical_customer_id: null,
          traits: input.traits,
          merged_into: null,
          first_seen_at: input.firstSeenAt,
          updated_at: input.firstSeenAt,
        })
        .execute();
    },

    async updateProfile(input): Promise<void> {
      await trx
        .updateTable("profiles")
        .set({
          canonical_customer_id: input.canonicalCustomerId,
          traits: input.traits,
          traits_version: String(input.traitsVersion),
          updated_at: input.updatedAt,
        })
        .where("profile_id", "=", input.profileId)
        .execute();
    },

    async countBindingsOfKind(profileId, kind): Promise<number> {
      const row = await trx
        .selectFrom("profile_identifiers")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("profile_id", "=", profileId)
        .where("kind", "=", kind)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async touchBinding(input): Promise<void> {
      await trx
        .updateTable("profile_identifiers")
        .set({ last_seen_at: input.at })
        .where("project_id", "=", input.scope.projectId)
        .where("environment", "=", input.scope.environment)
        .where("kind", "=", input.kind)
        .where("value", "=", input.value)
        .execute();
    },

    async bindIdentifier(input): Promise<void> {
      // ON CONFLICT makes the bind idempotent under redelivery: a replayed
      // event finds its own row and moves on.
      await trx
        .insertInto("profile_identifiers")
        .values({
          project_id: input.scope.projectId,
          environment: input.scope.environment,
          kind: input.kind,
          value: input.value,
          profile_id: input.profileId,
          first_seen_at: input.at,
          last_seen_at: input.at,
        })
        .onConflict((oc) =>
          oc
            .columns(["project_id", "environment", "kind", "value"])
            .doUpdateSet({ last_seen_at: input.at }),
        )
        .execute();
    },

    async countMergesSince(winnerProfileId, since): Promise<number> {
      const row = await trx
        .selectFrom("profile_merges")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("winner_profile_id", "=", winnerProfileId)
        .where("merged_at", ">=", since)
        .executeTakeFirst();
      return Number(row?.count ?? 0);
    },

    async repointBindings(input): Promise<number> {
      const moved = await trx
        .updateTable("profile_identifiers")
        .set({ profile_id: input.toProfileId, last_seen_at: input.at })
        .where("profile_id", "=", input.fromProfileId)
        .executeTakeFirst();
      return Number(moved.numUpdatedRows ?? 0);
    },

    async tombstoneProfile(input): Promise<void> {
      await trx
        .updateTable("profiles")
        .set({ merged_into: input.winnerProfileId, updated_at: input.at })
        .where("profile_id", "=", input.loserProfileId)
        .execute();
    },

    async recordMerge(record: MergeRecord): Promise<void> {
      await trx
        .insertInto("profile_merges")
        .values({
          merge_id: record.mergeId,
          project_id: record.scope.projectId,
          environment: record.scope.environment,
          winner_profile_id: record.winnerProfileId,
          loser_profile_id: record.loserProfileId,
          source_event_id: record.sourceEventId,
          evidence: record.evidence,
          merged_at: record.mergedAt,
        })
        .execute();
    },

    async recordLink(record: LinkRecord): Promise<void> {
      await trx
        .insertInto("identity_links")
        .values({
          link_id: record.linkId,
          project_id: record.scope.projectId,
          environment: record.scope.environment,
          left_identifier: record.leftIdentifier,
          right_identifier: record.rightIdentifier,
          confidence: record.confidence as "authoritative",
          evidence_type: record.evidenceType,
          evidence: {
            source_event_id: record.sourceEventId,
            source_event_name: record.sourceEventName,
          },
          reason: record.reason,
          // Who wrote the row is this unit's fact, not the graph's — the
          // ledger is queried by processor to tell the sync path's evidence
          // apart from an async processor's.
          processor_name: PROCESSOR_NAME,
          processor_version: PROCESSOR_VERSION,
          run_id: record.runId,
          created_at: record.createdAt,
          superseded_at: null,
        })
        .onConflict((oc) => oc.column("link_id").doNothing())
        .execute();
    },
  };
}
