/**
 * Profile-store access for the identity stage.
 *
 * This module owns the ONE transaction per event described in
 * `docs/implementation/pipeline-redesign-plan.md` §4.2. Everything that
 * writes to `profiles`, `profile_identifiers`, `profile_merges` or
 * `identity_links` on the sync path goes through `resolveProfile`.
 *
 * Two implementations ship: a Kysely one for production and an in-memory
 * one for tests. They are held to the same contract by the same test
 * suite, because the interesting behaviour here — idempotency under
 * redelivery, merge-winner selection, cap refusal — is semantic and not
 * about SQL.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely, Transaction } from "kysely";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";

import type { CollectedIdentifier, IdentityPolicy, StrongIdentityKind } from "./transform.js";

/** What the stage did, which decides which facts get emitted. */
export type ResolutionKind =
  | "created" // no identifier resolved: a new profile
  | "bound" // one profile resolved; zero or more identifiers newly bound
  | "merged" // two profiles resolved: they are one person
  | "unidentified"; // no strong identifiers survived collection

export interface BoundIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
  /** False when the identifier already pointed at this profile. */
  readonly newlyBound: boolean;
}

export interface MergeOutcome {
  readonly mergeId: string;
  readonly winnerProfileId: string;
  readonly loserProfileId: string;
  readonly identifiersMoved: number;
}

export interface RejectedIdentifier {
  readonly kind: StrongIdentityKind;
  readonly value: string;
  readonly reason: "identifier_cap" | "denylisted";
  readonly existingBindingCount?: number;
}

export interface ResolutionResult {
  readonly kind: ResolutionKind;
  readonly profileId: string | null;
  readonly canonicalCustomerId: string | null;
  readonly traitsVersion: number | null;
  readonly bound: readonly BoundIdentifier[];
  readonly merge: MergeOutcome | null;
  readonly rejected: readonly RejectedIdentifier[];
  /** Set when the merge-rate breaker refused a merge. */
  readonly mergeSuspended: {
    readonly profileId: string;
    readonly mergeCount: number;
  } | null;
  /** True when this event patched traits. */
  readonly traitsPatched: boolean;
}

export interface ResolveInput {
  readonly projectId: string;
  readonly environment: string;
  readonly identifiers: readonly CollectedIdentifier[];
  readonly traits: Record<string, unknown> | null;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly runId: string | null;
  readonly policy: IdentityPolicy;
  readonly now: Date;
}

export interface ProfileRepository {
  resolveProfile(input: ResolveInput): Promise<ResolutionResult>;
}

// ---------------------------------------------------------------------
// Kysely implementation
// ---------------------------------------------------------------------

export function createKyselyProfileRepository(db: Kysely<Database>): ProfileRepository {
  return {
    async resolveProfile(input: ResolveInput): Promise<ResolutionResult> {
      if (input.identifiers.length === 0) {
        return unidentifiedResult();
      }
      // One transaction for the whole decision. Everything below runs
      // inside it, and the caller publishes only after it commits — the
      // commit-before-publish invariant the enrichment stage depends on.
      return db.transaction().execute(async (trx) => runResolution(trx, input));
    },
  };
}

function unidentifiedResult(): ResolutionResult {
  return {
    kind: "unidentified",
    profileId: null,
    canonicalCustomerId: null,
    traitsVersion: null,
    bound: [],
    merge: null,
    rejected: [],
    mergeSuspended: null,
    traitsPatched: false,
  };
}

async function runResolution(
  trx: Transaction<Database>,
  input: ResolveInput,
): Promise<ResolutionResult> {
  // Step 2: look up every identifier, locking matched rows FOR UPDATE in
  // the canonical order the caller already sorted them into. Consistent
  // lock ordering across workers is what keeps two events touching the
  // same identifier pair from deadlocking.
  const existing = await trx
    .selectFrom("profile_identifiers")
    .selectAll()
    .where("project_id", "=", input.projectId)
    .where("environment", "=", input.environment)
    .where((eb) =>
      eb.or(
        input.identifiers.map((id) =>
          eb.and([eb("kind", "=", id.kind), eb("value", "=", id.value)]),
        ),
      ),
    )
    .forUpdate()
    .execute();

  const distinctProfileIds = [...new Set(existing.map((row) => row.profile_id))].sort();

  if (distinctProfileIds.length === 0) {
    return createProfileAndBind(trx, input);
  }
  if (distinctProfileIds.length === 1) {
    const profileId = distinctProfileIds[0] as string;
    return bindToProfile(trx, input, profileId, existing);
  }
  return mergeProfiles(trx, input, distinctProfileIds, existing);
}

/** Step 3: nothing resolved — create the profile and bind everything. */
async function createProfileAndBind(
  trx: Transaction<Database>,
  input: ResolveInput,
): Promise<ResolutionResult> {
  const profileId = uuidv7();

  await trx
    .insertInto("profiles")
    .values({
      profile_id: profileId,
      project_id: input.projectId,
      environment: input.environment,
      canonical_customer_id: null,
      traits: input.traits ?? {},
      merged_into: null,
      first_seen_at: input.now,
      updated_at: input.now,
    })
    .execute();

  const bound = await bindIdentifiers(trx, input, profileId, new Map());
  // Canonical comes from what actually BOUND, never from the raw input:
  // a profile must not claim a customer id whose identifier row does not
  // point back at it. On a fresh profile nothing can be cap-refused (at
  // most one identifier per kind arrives, against a count of zero), but
  // the rule is uniform across all three paths so it cannot drift.
  const canonicalCustomerId = pickCanonicalCustomerId(bound.bound) ?? null;
  const traitsVersion = input.traits === null ? 0 : 1;
  if (canonicalCustomerId !== null || input.traits !== null) {
    await trx
      .updateTable("profiles")
      .set({
        canonical_customer_id: canonicalCustomerId,
        traits_version: String(traitsVersion),
        updated_at: input.now,
      })
      .where("profile_id", "=", profileId)
      .execute();
  }

  return {
    kind: "created",
    profileId,
    canonicalCustomerId,
    traitsVersion,
    bound: bound.bound,
    merge: null,
    rejected: bound.rejected,
    mergeSuspended: null,
    traitsPatched: input.traits !== null,
  };
}

/** Step 4: exactly one profile — bind whatever is not yet bound. */
async function bindToProfile(
  trx: Transaction<Database>,
  input: ResolveInput,
  profileId: string,
  existing: ReadonlyArray<{ kind: string; value: string; profile_id: string }>,
): Promise<ResolutionResult> {
  const alreadyBound = new Map(existing.map((row) => [`${row.kind}:${row.value}`, row.profile_id]));
  const bound = await bindIdentifiers(trx, input, profileId, alreadyBound);
  const patched = await patchProfile(trx, input, profileId, bound.bound);

  return {
    kind: "bound",
    profileId,
    canonicalCustomerId: patched.canonicalCustomerId,
    traitsVersion: patched.traitsVersion,
    bound: bound.bound,
    merge: null,
    rejected: bound.rejected,
    mergeSuspended: null,
    traitsPatched: patched.traitsPatched,
  };
}

/**
 * Step 5: two profiles are one person.
 *
 * Winner is the OLDER profile (`first_seen_at`, ties broken by the lower
 * id) — a stable rule, so a replay of the same events picks the same
 * winner rather than shuffling which id survives.
 *
 * Repointing is eager: every one of the loser's identifiers moves to the
 * winner inside this transaction, so the read path is always one lookup
 * and `merged_into` never has to be traversed.
 */
async function mergeProfiles(
  trx: Transaction<Database>,
  input: ResolveInput,
  profileIds: readonly string[],
  existing: ReadonlyArray<{ kind: string; value: string; profile_id: string }>,
): Promise<ResolutionResult> {
  const profiles = await trx
    .selectFrom("profiles")
    .selectAll()
    .where("profile_id", "in", [...profileIds])
    .forUpdate()
    .execute();

  const ordered = [...profiles].sort((a, b) => {
    const at = new Date(a.first_seen_at).getTime();
    const bt = new Date(b.first_seen_at).getTime();
    if (at !== bt) return at - bt;
    return a.profile_id < b.profile_id ? -1 : 1;
  });
  const winner = ordered[0];
  const losers = ordered.slice(1);
  if (winner === undefined || losers.length === 0) {
    // Defensive: the caller only routes here with >1 distinct profile.
    return bindToProfile(trx, input, profileIds[0] as string, existing);
  }

  // Merge-rate breaker. A profile absorbing more merges than the policy
  // allows inside the window is the signature of a merge storm; stop it
  // here rather than discovering a mega-profile later.
  const windowStart = new Date(input.now.getTime() - input.policy.mergeWindowSeconds * 1000);
  const recent = await trx
    .selectFrom("profile_merges")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("winner_profile_id", "=", winner.profile_id)
    .where("merged_at", ">=", windowStart)
    .executeTakeFirst();
  const recentCount = Number(recent?.count ?? 0);
  if (recentCount >= input.policy.maxMergesPerWindow) {
    // Refuse the merge, but still resolve the event to the winner so it
    // keeps flowing. The operator gets an event; the graph stops growing.
    // Nothing binds on this path — moving the event's identifiers to the
    // winner would BE the merge — so the empty bound set also means the
    // canonical customer id cannot change here.
    const patched = await patchProfile(trx, input, winner.profile_id, []);
    return {
      kind: "bound",
      profileId: winner.profile_id,
      canonicalCustomerId: patched.canonicalCustomerId,
      traitsVersion: patched.traitsVersion,
      bound: [],
      merge: null,
      rejected: [],
      mergeSuspended: { profileId: winner.profile_id, mergeCount: recentCount },
      traitsPatched: patched.traitsPatched,
    };
  }

  let identifiersMoved = 0;
  const mergeId = uuidv7();
  for (const loser of losers) {
    const moved = await trx
      .updateTable("profile_identifiers")
      .set({ profile_id: winner.profile_id, last_seen_at: input.now })
      .where("profile_id", "=", loser.profile_id)
      .executeTakeFirst();
    identifiersMoved += Number(moved.numUpdatedRows ?? 0);

    await trx
      .updateTable("profiles")
      .set({ merged_into: winner.profile_id, updated_at: input.now })
      .where("profile_id", "=", loser.profile_id)
      .execute();

    await trx
      .insertInto("profile_merges")
      .values({
        merge_id: losers.length === 1 ? mergeId : uuidv7(),
        project_id: input.projectId,
        environment: input.environment,
        winner_profile_id: winner.profile_id,
        loser_profile_id: loser.profile_id,
        source_event_id: input.sourceEventId,
        evidence: {
          source_event_name: input.sourceEventName,
          identifiers: input.identifiers.map((i) => `${i.kind}:${i.value}`),
        },
        merged_at: input.now,
      })
      .execute();
  }

  const alreadyBound = new Map(
    existing.map((row) => [`${row.kind}:${row.value}`, winner.profile_id]),
  );
  const bound = await bindIdentifiers(trx, input, winner.profile_id, alreadyBound);
  const patched = await patchProfile(trx, input, winner.profile_id, bound.bound);

  return {
    kind: "merged",
    profileId: winner.profile_id,
    canonicalCustomerId: patched.canonicalCustomerId,
    traitsVersion: patched.traitsVersion,
    bound: bound.bound,
    merge: {
      mergeId,
      winnerProfileId: winner.profile_id,
      loserProfileId: losers[0]?.profile_id as string,
      identifiersMoved,
    },
    rejected: bound.rejected,
    mergeSuspended: null,
    traitsPatched: patched.traitsPatched,
  };
}

/**
 * Bind identifiers not already pointing at this profile, enforcing the
 * per-kind cap.
 *
 * The cap check counts existing bindings of that kind and refuses beyond
 * the limit. Refusal is a recorded fact, not a silent skip: a runaway
 * producer looks exactly like a producer bug otherwise.
 */
async function bindIdentifiers(
  trx: Transaction<Database>,
  input: ResolveInput,
  profileId: string,
  alreadyBound: ReadonlyMap<string, string>,
): Promise<{ bound: BoundIdentifier[]; rejected: RejectedIdentifier[] }> {
  const bound: BoundIdentifier[] = [];
  const rejected: RejectedIdentifier[] = [];

  for (const identifier of input.identifiers) {
    const key = `${identifier.kind}:${identifier.value}`;
    if (alreadyBound.get(key) === profileId) {
      bound.push({ ...identifier, newlyBound: false });
      await trx
        .updateTable("profile_identifiers")
        .set({ last_seen_at: input.now })
        .where("project_id", "=", input.projectId)
        .where("environment", "=", input.environment)
        .where("kind", "=", identifier.kind)
        .where("value", "=", identifier.value)
        .execute();
      continue;
    }

    const countRow = await trx
      .selectFrom("profile_identifiers")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("profile_id", "=", profileId)
      .where("kind", "=", identifier.kind)
      .executeTakeFirst();
    const existingCount = Number(countRow?.count ?? 0);
    if (existingCount >= input.policy.maxIdentifiersPerKind) {
      rejected.push({
        ...identifier,
        reason: "identifier_cap",
        existingBindingCount: existingCount,
      });
      continue;
    }

    // ON CONFLICT DO NOTHING makes the bind idempotent under redelivery:
    // a replayed event finds its own row and moves on.
    await trx
      .insertInto("profile_identifiers")
      .values({
        project_id: input.projectId,
        environment: input.environment,
        kind: identifier.kind,
        value: identifier.value,
        profile_id: profileId,
        first_seen_at: input.now,
        last_seen_at: input.now,
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "environment", "kind", "value"]).doUpdateSet({
          last_seen_at: input.now,
        }),
      )
      .execute();

    bound.push({ ...identifier, newlyBound: true });
  }

  // The evidence ledger keeps its original job: why we believe two
  // identifiers are one person. Written once per event — outside the
  // per-identifier loop — and only when the event changed the graph:
  // re-seeing a fully-bound pair is the steady state, not new evidence.
  if (input.identifiers.length > 1 && bound.some((b) => b.newlyBound)) {
    const pair = [...input.identifiers].map((i) => `${i.kind}:${i.value}`).sort();
    await trx
      .insertInto("identity_links")
      .values({
        link_id: deriveIdentityLinkId(input, pair[0] as string, pair[1] as string),
        project_id: input.projectId,
        environment: input.environment,
        left_identifier: pair[0] as string,
        right_identifier: pair[1] as string,
        confidence: "authoritative",
        evidence_type: "explicit_overlap",
        evidence: {
          source_event_id: input.sourceEventId,
          source_event_name: input.sourceEventName,
        },
        reason: "identifiers co-occurred on one event",
        processor_name: "sync-identity-resolver",
        processor_version: "v1",
        run_id: input.runId,
        created_at: input.now,
        superseded_at: null,
      })
      .onConflict((oc) => oc.column("link_id").doNothing())
      .execute();
  }

  return { bound, rejected };
}

/**
 * Namespace for identity-link ledger ids. Module-private and frozen: the
 * id is part of the storage format, and changing the namespace would
 * re-mint every ledger row's identity.
 */
const IDENTITY_LINK_NAMESPACE = "3c9d4a71-52e8-4b0f-9f6d-8e2b7c50a114";

/**
 * Deterministic ledger id: one row per (scope, pair, evidence type).
 *
 * `identity_links` carries no unique constraint on the pair — its primary
 * key is `link_id` — so a random id would make the `ON CONFLICT` above
 * unreachable and the ledger would grow one row per DELIVERY: twice per
 * login event (two newly-bound identifiers used to each write the pair)
 * and again on every redelivery or replay. Deriving the id from the fact
 * itself makes the write idempotent against the existing primary key,
 * the same way `deriveEventId` makes derived-event emission idempotent.
 *
 * `source_event_id` is deliberately NOT in the key: the ledger answers
 * "why do we believe these two identifiers are one person", and the
 * first observation answers it. Async processors that later evidence the
 * same pair differently get their own rows via their own evidence type.
 */
function deriveIdentityLinkId(input: ResolveInput, left: string, right: string): string {
  return uuidv5(
    `${input.projectId}|${input.environment}|${left}|${right}|explicit_overlap`,
    IDENTITY_LINK_NAMESPACE,
  );
}

/**
 * Apply the canonical customer id and any trait patch, returning the
 * profile's post-write state.
 *
 * `bound` is the set of identifiers that actually point at this profile
 * after binding. The canonical customer id is picked from IT, never from
 * the raw input: a cap-refused `customer_id` must not become canonical,
 * because its identifier row resolves elsewhere (or will create a fresh
 * profile on the next lookup) and destinations key on this column.
 */
async function patchProfile(
  trx: Transaction<Database>,
  input: ResolveInput,
  profileId: string,
  bound: readonly BoundIdentifier[],
): Promise<{
  canonicalCustomerId: string | null;
  traitsVersion: number;
  traitsPatched: boolean;
}> {
  // FOR UPDATE, because this is a read-modify-write and partition order
  // does not serialize it: `raw.events` is keyed on the identity fallback
  // chain (customer_id, then anonymous_id), so until a person's history
  // unifies, their events straddle two partitions and two workers can
  // reach the same profile at once. The row lock makes "last write wins"
  // mean commit order; without it a whole trait patch can vanish and two
  // events can claim the same traits_version. The merge path locks this
  // row earlier via its profiles SELECT; re-taking a held lock is free.
  //
  // A concurrent merge holding this row while repointing identifier rows
  // this transaction locked can deadlock against it. That is accepted:
  // PostgreSQL aborts one transaction, the message redelivers, and the
  // re-run is idempotent — it surfaces as a retry, not as corruption.
  const current = await trx
    .selectFrom("profiles")
    .select(["canonical_customer_id", "traits", "traits_version"])
    .where("profile_id", "=", profileId)
    .forUpdate()
    .executeTakeFirst();

  const currentVersion = Number(current?.traits_version ?? 0);
  const customerId = pickCanonicalCustomerId(bound);
  const nextCustomerId = customerId ?? current?.canonical_customer_id ?? null;
  const patched = input.traits !== null;

  if (!patched && nextCustomerId === (current?.canonical_customer_id ?? null)) {
    return {
      canonicalCustomerId: nextCustomerId,
      traitsVersion: currentVersion,
      traitsPatched: false,
    };
  }

  // Merge-patch per key. Last-write-wins, where "last" is the order in
  // which the serialized transactions committed on the locked row.
  const nextTraits = patched
    ? { ...((current?.traits as Record<string, unknown>) ?? {}), ...input.traits }
    : ((current?.traits as Record<string, unknown>) ?? {});
  const nextVersion = patched ? currentVersion + 1 : currentVersion;

  await trx
    .updateTable("profiles")
    .set({
      canonical_customer_id: nextCustomerId,
      traits: nextTraits,
      traits_version: String(nextVersion),
      updated_at: input.now,
    })
    .where("profile_id", "=", profileId)
    .execute();

  return {
    canonicalCustomerId: nextCustomerId,
    traitsVersion: nextVersion,
    traitsPatched: patched,
  };
}

function pickCanonicalCustomerId(
  identifiers: readonly { kind: StrongIdentityKind; value: string }[],
): string | undefined {
  return identifiers.find((i) => i.kind === "customer_id")?.value;
}
