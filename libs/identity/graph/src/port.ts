/**
 * The storage port every profile-store write goes through.
 *
 * `resolve.ts` is the decision — plan §4.2, step for step — and it never
 * names a database. This interface is the whole of what it needs a store
 * to do, and the two implementations that exist are held to it by the
 * same suite: a Kysely one inside `sync/identity/resolver/v1`, and an
 * in-memory one in that unit's tests.
 *
 * ## Every method runs inside ONE transaction
 *
 * The port does not expose `begin` or `commit`, and that is the point.
 * A caller obtains a store that is ALREADY scoped to a transaction — the
 * Kysely adapter builds one per `resolveProfile` — so there is no way to
 * express a resolution that half-commits. The invariant downstream
 * depends on (commit before publish) is then the caller's single
 * ordering decision rather than a property spread across ten methods.
 *
 * ## Locking is a port method, not an implementation detail
 *
 * `lockIdentifier` exists because `SELECT ... FOR UPDATE` locks the rows
 * it FINDS, which is exactly nothing on an identifier nobody has bound
 * yet — and that is the first-sighting case. Two workers seeing the same
 * brand-new customer_id at once both matched zero rows, both created a
 * profile, and the identifier's primary key let only one of them own it;
 * the loser walked away holding a profile id with no identifier pointing
 * at it and stamped that orphan onto the spine. One person, two
 * profiles, silently. A lock taken on a VALUE exists whether or not the
 * row does, which is why the decision procedure — not the adapter —
 * gets to insist on it.
 */

import type { StrongIdentityKind } from "@polaris/identity-rules";

import type { GraphProfile, GraphScope, IdentifierBinding } from "./model.js";

/** The merge, as the evidence ledger records it. */
export interface MergeRecord {
  readonly mergeId: string;
  readonly scope: GraphScope;
  readonly winnerProfileId: string;
  readonly loserProfileId: string;
  readonly sourceEventId: string;
  readonly evidence: Record<string, unknown>;
  readonly mergedAt: Date;
}

/**
 * One row of `identity_links`: why two identifiers are believed to be
 * one person.
 *
 * `confidence`, `evidenceType` and `reason` travel on the record rather
 * than being filled in by the adapter, because they describe the
 * EVIDENCE and the evidence is the domain's. What the adapter adds is
 * the processor name and version — who wrote the row is the unit's fact,
 * not the graph's.
 */
export interface LinkRecord {
  readonly linkId: string;
  readonly scope: GraphScope;
  readonly leftIdentifier: string;
  readonly rightIdentifier: string;
  readonly confidence: string;
  readonly evidenceType: string;
  readonly reason: string;
  readonly sourceEventId: string;
  readonly sourceEventName: string;
  readonly runId: string | null;
  readonly createdAt: Date;
}

export interface IdentityGraphStore {
  /**
   * Mint a row id.
   *
   * On the port because row identity is the store's, and because the
   * fakes need it deterministic — uuidv7 in production, a padded
   * counter in tests, and the merge tiebreak compares ids as strings in
   * both.
   */
  newId(): string;

  /** Take the transaction-scoped lock for one identifier value. */
  lockIdentifier(key: string): Promise<void>;

  /** Bindings for these identifiers, locked for update. */
  findBindings(
    scope: GraphScope,
    identifiers: readonly { readonly kind: StrongIdentityKind; readonly value: string }[],
  ): Promise<readonly IdentifierBinding[]>;

  /** Profiles by id, locked for update. Missing ids are simply absent. */
  loadProfiles(profileIds: readonly string[]): Promise<readonly GraphProfile[]>;

  insertProfile(input: {
    readonly profileId: string;
    readonly scope: GraphScope;
    readonly traits: Record<string, unknown>;
    readonly firstSeenAt: Date;
  }): Promise<void>;

  updateProfile(input: {
    readonly profileId: string;
    readonly canonicalCustomerId: string | null;
    readonly traits: Record<string, unknown>;
    readonly traitsVersion: number;
    readonly updatedAt: Date;
  }): Promise<void>;

  /** Bindings of one kind this profile already holds — the cap check. */
  countBindingsOfKind(profileId: string, kind: StrongIdentityKind): Promise<number>;

  /** Re-seeing a binding that already points here: last_seen_at only. */
  touchBinding(input: {
    readonly scope: GraphScope;
    readonly kind: StrongIdentityKind;
    readonly value: string;
    readonly at: Date;
  }): Promise<void>;

  /** Bind an identifier to a profile. Idempotent under redelivery. */
  bindIdentifier(input: {
    readonly scope: GraphScope;
    readonly kind: StrongIdentityKind;
    readonly value: string;
    readonly profileId: string;
    readonly at: Date;
  }): Promise<void>;

  /** Merges this profile absorbed since `since` — the breaker's input. */
  countMergesSince(winnerProfileId: string, since: Date): Promise<number>;

  /** Move every binding from loser to winner. Returns how many moved. */
  repointBindings(input: {
    readonly fromProfileId: string;
    readonly toProfileId: string;
    readonly at: Date;
  }): Promise<number>;

  /** Stamp `merged_into` on the loser. The row stays; it is the tombstone. */
  tombstoneProfile(input: {
    readonly loserProfileId: string;
    readonly winnerProfileId: string;
    readonly at: Date;
  }): Promise<void>;

  recordMerge(record: MergeRecord): Promise<void>;

  /** Idempotent on `linkId`: a re-seen pair is not new evidence. */
  recordLink(record: LinkRecord): Promise<void>;
}
