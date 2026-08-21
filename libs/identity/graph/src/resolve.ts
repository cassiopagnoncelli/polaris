/**
 * Resolution: one decision per event, against the storage port.
 *
 * This is `docs/implementation/pipeline-redesign-plan.md` §4.2 in code —
 * lock, look up, then create / bind / merge — and it is the highest-value
 * thing in the carve-out, because `resolver/v1` replay output is a
 * correctness contract. Unmerge is replay-rebuild
 * (`@polaris/identity-merge`), so "the same events produce the same
 * graph" is not a nice property of this function, it is the property the
 * repair path is built on. ADR-0007's third law therefore binds here
 * hardest: a semantic change takes a new entrypoint or a major version,
 * never an edit in place.
 *
 * Nothing below names a database, a clock or a broker. `now` arrives on
 * the input, ids come from the port, and every read and write is a port
 * call — which is what lets the same procedure run against Postgres in
 * production and against a Map in a test, with the goldens proving they
 * agree.
 *
 * ## Idempotent under redelivery
 *
 * Every step is an upsert or a no-op on re-execution, so a rewind that
 * replays a merge finds the identifiers already repointed and emits
 * nothing new. That is what removes the emit-then-rewind hazard the v1
 * resolver documented, where a replayed merge downgraded to
 * `identity.linked`.
 */

import type { CollectedIdentifier, StrongIdentityKind } from "@polaris/identity-rules";
import {
  evaluateMergeRate,
  type MergeOutcome,
  mergeWindowStart,
  type RejectedIdentifier,
  selectMergeWinner,
} from "@polaris/identity-merge";
import {
  applyTraitPatch,
  type BoundIdentifier,
  pickCanonicalCustomerId,
  type ResolutionResult,
  type ResolveInput,
  unidentifiedResolution,
} from "@polaris/profiles";

import { v5 as uuidv5 } from "uuid";

import { bindingKey, type GraphScope, type IdentifierBinding } from "./model.js";
import type { IdentityGraphStore } from "./port.js";

/**
 * Namespace for identity-link ledger ids. Frozen: the id is part of the
 * storage format, and changing the namespace would re-mint every ledger
 * row's identity.
 */
const IDENTITY_LINK_NAMESPACE = "3c9d4a71-52e8-4b0f-9f6d-8e2b7c50a114";

/**
 * The evidence class the sync path writes: two identifiers arrived on one
 * event. It is part of the link id's key material, so a second evidence
 * class for the same pair is a different row rather than a collision.
 */
const IDENTITY_LINK_EVIDENCE_TYPE = "explicit_overlap";

/**
 * Deterministic ledger id: one row per (scope, pair, evidence type).
 *
 * `identity_links` carries no unique constraint on the pair — its primary
 * key is `link_id` — so a random id would make the write's `ON CONFLICT`
 * unreachable and the ledger would grow one row per DELIVERY: twice per
 * login event (two newly-bound identifiers each writing the pair) and
 * again on every redelivery or replay. Deriving the id from the fact
 * itself makes the write idempotent against the primary key already
 * there, the same way `deriveEventId` makes derived event emission
 * idempotent.
 *
 * `source_event_id` is deliberately NOT in the key: the ledger answers
 * "why do we believe these two identifiers are one person", and the first
 * observation answers it. Async processors that later evidence the same
 * pair differently get their own rows via their own evidence type.
 */
function deriveIdentityLinkId(scope: GraphScope, left: string, right: string): string {
  return uuidv5(
    `${scope.projectId}|${scope.environment}|${left}|${right}|${IDENTITY_LINK_EVIDENCE_TYPE}`,
    IDENTITY_LINK_NAMESPACE,
  );
}

/**
 * The profiles a set of identifiers currently resolves to.
 *
 * Sorted, and that is not cosmetic: zero, one and many are three
 * different branches, and the sort makes the branch decision reproducible
 * when the store returns rows in whatever order it happened to find them.
 */
function distinctProfiles(bindings: readonly IdentifierBinding[]): readonly string[] {
  return [...new Set(bindings.map((binding) => binding.profileId))].sort();
}

/**
 * The string an identifier's advisory lock is taken on.
 *
 * Scoped to (project, environment) as well as (kind, value), so two
 * projects that happen to share a customer id never queue behind each
 * other — identity graphs are project-bounded, and the lock should be too.
 */
function identifierLockKey(scope: GraphScope, identifier: CollectedIdentifier): string {
  return `polaris:identity:${scope.projectId}:${scope.environment}:${identifier.kind}:${identifier.value}`;
}

/**
 * Resolve one event against the graph.
 *
 * The caller supplies a store already scoped to a transaction; this
 * function performs no transaction control of its own, because the
 * commit boundary IS the contract with the rest of the pipeline (commit
 * before publish, so enrichment can never read a profile that does not
 * exist yet).
 */
export async function resolveIdentity(
  store: IdentityGraphStore,
  input: ResolveInput,
): Promise<ResolutionResult> {
  if (input.identifiers.length === 0) return unidentifiedResolution();

  const scope: GraphScope = { projectId: input.projectId, environment: input.environment };

  // Step 1: lock every identifier VALUE before looking anything up. See
  // the port's header for the orphan-profile race this closes, and why
  // row locks cannot close it. Taken in the canonical (kind, value)
  // order the caller already sorted into, so two events touching the
  // same pair queue rather than deadlock.
  for (const identifier of input.identifiers) {
    await store.lockIdentifier(identifierLockKey(scope, identifier));
  }

  // Step 2: look up every identifier, locking matched rows for update.
  const existing = await store.findBindings(scope, input.identifiers);
  const matched = distinctProfiles(existing);

  if (matched.length === 0) return createProfileAndBind(store, scope, input);
  if (matched.length === 1) {
    return bindToProfile(store, scope, input, matched[0] as string, existing);
  }
  return mergeProfiles(store, scope, input, matched, existing);
}

/** Step 3: nothing resolved — create the profile and bind everything. */
async function createProfileAndBind(
  store: IdentityGraphStore,
  scope: GraphScope,
  input: ResolveInput,
): Promise<ResolutionResult> {
  const profileId = store.newId();

  await store.insertProfile({
    profileId,
    scope,
    traits: input.traits ?? {},
    firstSeenAt: input.now,
  });

  const bound = await bindIdentifiers(store, scope, input, profileId, new Map());
  // Canonical comes from what actually BOUND, never from the raw input.
  // On a fresh profile nothing can be cap-refused (at most one identifier
  // per kind arrives, against a count of zero), but the rule is uniform
  // across all three paths so it cannot drift.
  const canonicalCustomerId = pickCanonicalCustomerId(bound.bound) ?? null;
  const traitsVersion = input.traits === null ? 0 : 1;
  if (canonicalCustomerId !== null || input.traits !== null) {
    await store.updateProfile({
      profileId,
      canonicalCustomerId,
      traits: input.traits ?? {},
      traitsVersion,
      updatedAt: input.now,
    });
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
  store: IdentityGraphStore,
  scope: GraphScope,
  input: ResolveInput,
  profileId: string,
  existing: readonly IdentifierBinding[],
): Promise<ResolutionResult> {
  const alreadyBound = new Map(existing.map((row) => [bindingKey(row), row.profileId]));
  const bound = await bindIdentifiers(store, scope, input, profileId, alreadyBound);
  const patched = await patchProfile(store, input, profileId, bound.bound);

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
 * Winner selection and the rate breaker are `@polaris/identity-merge`'s;
 * what happens here is the repoint, which is eager so the read path
 * stays one hop and `merged_into` never has to be traversed.
 */
async function mergeProfiles(
  store: IdentityGraphStore,
  scope: GraphScope,
  input: ResolveInput,
  profileIds: readonly string[],
  existing: readonly IdentifierBinding[],
): Promise<ResolutionResult> {
  const profiles = await store.loadProfiles(profileIds);
  const selection = selectMergeWinner(
    profiles.map((profile) => ({ profileId: profile.profileId, firstSeenAt: profile.firstSeenAt })),
  );
  if (selection === null) {
    // Defensive: the caller only routes here with more than one distinct
    // profile, so this means the store lost a row between the two reads.
    return bindToProfile(store, scope, input, profileIds[0] as string, existing);
  }
  const { winner, losers } = selection;

  // Merge-rate breaker. A profile absorbing more merges than the policy
  // allows inside the window is the signature of a merge storm.
  const recentMerges = await store.countMergesSince(
    winner.profileId,
    mergeWindowStart(input.now, input.policy),
  );
  const verdict = evaluateMergeRate({
    winnerProfileId: winner.profileId,
    recentMerges,
    bounds: input.policy,
  });
  if (!verdict.allowed) {
    // Refuse the merge, but still resolve the event to the winner so it
    // keeps flowing. Nothing binds on this path — moving the event's
    // identifiers to the winner would BE the merge — so the empty bound
    // set also means the canonical customer id cannot change here.
    const patched = await patchProfile(store, input, winner.profileId, []);
    return {
      kind: "bound",
      profileId: winner.profileId,
      canonicalCustomerId: patched.canonicalCustomerId,
      traitsVersion: patched.traitsVersion,
      bound: [],
      merge: null,
      rejected: [],
      mergeSuspended: verdict.suspension,
      traitsPatched: patched.traitsPatched,
    };
  }

  let identifiersMoved = 0;
  const mergeId = store.newId();
  for (const loser of losers) {
    identifiersMoved += await store.repointBindings({
      fromProfileId: loser.profileId,
      toProfileId: winner.profileId,
      at: input.now,
    });
    await store.tombstoneProfile({
      loserProfileId: loser.profileId,
      winnerProfileId: winner.profileId,
      at: input.now,
    });
    await store.recordMerge({
      // The reported merge id belongs to the pair the FACT names, which is
      // the first loser; a three-way collapse mints a fresh id per extra
      // pair rather than filing them all under one.
      mergeId: losers.length === 1 ? mergeId : store.newId(),
      scope,
      winnerProfileId: winner.profileId,
      loserProfileId: loser.profileId,
      sourceEventId: input.sourceEventId,
      evidence: {
        source_event_name: input.sourceEventName,
        identifiers: input.identifiers.map((identifier) => bindingKey(identifier)),
      },
      mergedAt: input.now,
    });
  }

  // Every existing binding points at the winner now, by construction.
  const alreadyBound = new Map(existing.map((row) => [bindingKey(row), winner.profileId]));
  const bound = await bindIdentifiers(store, scope, input, winner.profileId, alreadyBound);
  const patched = await patchProfile(store, input, winner.profileId, bound.bound);

  const merge: MergeOutcome = {
    mergeId,
    winnerProfileId: winner.profileId,
    loserProfileId: losers[0]?.profileId as string,
    identifiersMoved,
  };

  return {
    kind: "merged",
    profileId: winner.profileId,
    canonicalCustomerId: patched.canonicalCustomerId,
    traitsVersion: patched.traitsVersion,
    bound: bound.bound,
    merge,
    rejected: bound.rejected,
    mergeSuspended: null,
    traitsPatched: patched.traitsPatched,
  };
}

/**
 * Bind identifiers not already pointing at this profile, enforcing the
 * per-kind cap.
 *
 * Refusal is a recorded fact, not a silent skip: a runaway producer
 * looks exactly like a producer bug otherwise.
 */
async function bindIdentifiers(
  store: IdentityGraphStore,
  scope: GraphScope,
  input: ResolveInput,
  profileId: string,
  alreadyBound: ReadonlyMap<string, string>,
): Promise<{ bound: BoundIdentifier[]; rejected: RejectedIdentifier[] }> {
  const bound: BoundIdentifier[] = [];
  const rejected: RejectedIdentifier[] = [];

  for (const identifier of input.identifiers) {
    if (alreadyBound.get(bindingKey(identifier)) === profileId) {
      bound.push({ ...identifier, newlyBound: false });
      await store.touchBinding({ scope, ...identifier, at: input.now });
      continue;
    }

    const existingCount = await store.countBindingsOfKind(profileId, identifier.kind);
    if (existingCount >= input.policy.maxIdentifiersPerKind) {
      rejected.push({
        ...identifier,
        reason: "identifier_cap",
        existingBindingCount: existingCount,
      });
      continue;
    }

    await store.bindIdentifier({ scope, ...identifier, profileId, at: input.now });
    bound.push({ ...identifier, newlyBound: true });
  }

  await recordEvidence(store, scope, input, bound);
  return { bound, rejected };
}

/**
 * The evidence ledger keeps its original job: why we believe two
 * identifiers are one person.
 *
 * Written once per event — outside the per-identifier loop — and only
 * when the event changed the graph: re-seeing a fully-bound pair is the
 * steady state, not new evidence.
 */
async function recordEvidence(
  store: IdentityGraphStore,
  scope: GraphScope,
  input: ResolveInput,
  bound: readonly BoundIdentifier[],
): Promise<void> {
  if (input.identifiers.length <= 1) return;
  if (!bound.some((entry) => entry.newlyBound)) return;

  const pair = input.identifiers.map((identifier) => bindingKey(identifier)).sort();
  const left = pair[0] as string;
  const right = pair[1] as string;
  await store.recordLink({
    linkId: deriveIdentityLinkId(scope, left, right),
    scope,
    leftIdentifier: left,
    rightIdentifier: right,
    confidence: "authoritative",
    evidenceType: IDENTITY_LINK_EVIDENCE_TYPE,
    reason: "identifiers co-occurred on one event",
    sourceEventId: input.sourceEventId,
    sourceEventName: input.sourceEventName,
    runId: input.runId,
    createdAt: input.now,
  });
}

/**
 * Apply the canonical customer id and any trait patch, returning the
 * profile's post-write state.
 *
 * `bound` is the set of identifiers that actually point at this profile
 * after binding — the canonical id is picked from IT, never from the raw
 * input.
 */
async function patchProfile(
  store: IdentityGraphStore,
  input: ResolveInput,
  profileId: string,
  bound: readonly { readonly kind: StrongIdentityKind; readonly value: string }[],
): Promise<{
  canonicalCustomerId: string | null;
  traitsVersion: number;
  traitsPatched: boolean;
}> {
  // Locked for update, because this is a read-modify-write and partition
  // order does not serialize it: `raw.events` is keyed on the identity
  // fallback chain, so until a person's history unifies their events
  // straddle two partitions and two workers can reach the same profile at
  // once. Without the lock a whole trait patch can vanish and two events
  // can claim the same traits_version.
  //
  // A concurrent merge holding this row while repointing bindings this
  // caller locked can deadlock against it. That is accepted: the store
  // aborts one side, the message redelivers, and the re-run is idempotent
  // — it surfaces as a retry, not as corruption.
  const current = (await store.loadProfiles([profileId]))[0];
  const currentState: { traits: Record<string, unknown>; traitsVersion: number } = {
    traits: current?.traits ?? {},
    traitsVersion: current?.traitsVersion ?? 0,
  };

  const customerId = pickCanonicalCustomerId(bound);
  const nextCustomerId = customerId ?? current?.canonicalCustomerId ?? null;
  const next = applyTraitPatch(currentState, input.traits);

  if (!next.patched && nextCustomerId === (current?.canonicalCustomerId ?? null)) {
    return {
      canonicalCustomerId: nextCustomerId,
      traitsVersion: currentState.traitsVersion,
      traitsPatched: false,
    };
  }

  await store.updateProfile({
    profileId,
    canonicalCustomerId: nextCustomerId,
    traits: next.traits,
    traitsVersion: next.traitsVersion,
    updatedAt: input.now,
  });

  return {
    canonicalCustomerId: nextCustomerId,
    traitsVersion: next.traitsVersion,
    traitsPatched: next.patched,
  };
}
