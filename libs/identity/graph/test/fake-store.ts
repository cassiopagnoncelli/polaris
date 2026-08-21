/**
 * An in-memory `IdentityGraphStore`, plus a log of what was asked of it.
 *
 * The port exists so the decision procedure can be exercised without a
 * database; this is the fake that makes that true. It records calls as
 * well as state, because half of what `resolveIdentity` guarantees is
 * about ORDER — locks before lookups, in canonical order — and a store
 * that only kept state could not tell the difference.
 *
 * Deliberately the STRICTER store where the two could differ: identifier
 * bindings are a map, so the uniqueness a primary key enforces is
 * enforced here too, and a test that would only pass against a looser
 * store fails here.
 */

import type {
  GraphProfile,
  GraphScope,
  IdentifierBinding,
  IdentityGraphStore,
  LinkRecord,
  MergeRecord,
} from "../src/index.js";

interface ProfileRow {
  profileId: string;
  canonicalCustomerId: string | null;
  traits: Record<string, unknown>;
  traitsVersion: number;
  mergedInto: string | null;
  firstSeenAt: Date;
}

function scopedKey(scope: GraphScope, kind: string, value: string): string {
  return `${scope.projectId}|${scope.environment}|${kind}|${value}`;
}

export class FakeGraphStore implements IdentityGraphStore {
  public readonly calls: string[] = [];
  public readonly merges: MergeRecord[] = [];
  public readonly links: LinkRecord[] = [];
  public readonly profiles = new Map<string, ProfileRow>();
  /** `${project}|${env}|${kind}|${value}` -> profileId */
  public readonly bindings = new Map<string, string>();

  private ids = 0;

  /**
   * Zero-padded, because the merge tiebreak compares ids as strings and
   * an unpadded counter inverts it at the 9→10 boundary — `"p-10" <
   * "p-9"` — which would flip the winner depending on how many profiles
   * earlier tests happened to create.
   */
  public newId(): string {
    this.ids += 1;
    return `id-${String(this.ids).padStart(6, "0")}`;
  }

  public async lockIdentifier(key: string): Promise<void> {
    this.calls.push(`lock:${key}`);
  }

  public async findBindings(
    scope: GraphScope,
    identifiers: readonly { readonly kind: string; readonly value: string }[],
  ): Promise<readonly IdentifierBinding[]> {
    this.calls.push("findBindings");
    const found: IdentifierBinding[] = [];
    for (const identifier of identifiers) {
      const profileId = this.bindings.get(scopedKey(scope, identifier.kind, identifier.value));
      if (profileId !== undefined) {
        found.push({
          kind: identifier.kind as IdentifierBinding["kind"],
          value: identifier.value,
          profileId,
        });
      }
    }
    return found;
  }

  public async loadProfiles(profileIds: readonly string[]): Promise<readonly GraphProfile[]> {
    this.calls.push("loadProfiles");
    return profileIds
      .map((id) => this.profiles.get(id))
      .filter((row): row is ProfileRow => row !== undefined)
      .map((row) => ({
        profileId: row.profileId,
        canonicalCustomerId: row.canonicalCustomerId,
        traits: row.traits,
        traitsVersion: row.traitsVersion,
        firstSeenAt: row.firstSeenAt,
      }));
  }

  public async insertProfile(input: {
    profileId: string;
    scope: GraphScope;
    traits: Record<string, unknown>;
    firstSeenAt: Date;
  }): Promise<void> {
    this.calls.push("insertProfile");
    this.profiles.set(input.profileId, {
      profileId: input.profileId,
      canonicalCustomerId: null,
      traits: input.traits,
      traitsVersion: 0,
      mergedInto: null,
      firstSeenAt: input.firstSeenAt,
    });
  }

  public async updateProfile(input: {
    profileId: string;
    canonicalCustomerId: string | null;
    traits: Record<string, unknown>;
    traitsVersion: number;
  }): Promise<void> {
    this.calls.push("updateProfile");
    const row = this.profiles.get(input.profileId);
    if (row === undefined) return;
    row.canonicalCustomerId = input.canonicalCustomerId;
    row.traits = input.traits;
    row.traitsVersion = input.traitsVersion;
  }

  public async countBindingsOfKind(profileId: string, kind: string): Promise<number> {
    return [...this.bindings.entries()].filter(
      ([key, value]) => value === profileId && key.split("|")[2] === kind,
    ).length;
  }

  public async touchBinding(input: {
    scope: GraphScope;
    kind: string;
    value: string;
  }): Promise<void> {
    this.calls.push(`touch:${input.kind}:${input.value}`);
  }

  public async bindIdentifier(input: {
    scope: GraphScope;
    kind: string;
    value: string;
    profileId: string;
  }): Promise<void> {
    this.calls.push(`bind:${input.kind}:${input.value}`);
    this.bindings.set(scopedKey(input.scope, input.kind, input.value), input.profileId);
  }

  public async countMergesSince(winnerProfileId: string, since: Date): Promise<number> {
    return this.merges.filter(
      (merge) => merge.winnerProfileId === winnerProfileId && merge.mergedAt >= since,
    ).length;
  }

  public async repointBindings(input: {
    fromProfileId: string;
    toProfileId: string;
  }): Promise<number> {
    let moved = 0;
    for (const [key, value] of this.bindings.entries()) {
      if (value === input.fromProfileId) {
        this.bindings.set(key, input.toProfileId);
        moved += 1;
      }
    }
    return moved;
  }

  public async tombstoneProfile(input: {
    loserProfileId: string;
    winnerProfileId: string;
  }): Promise<void> {
    const row = this.profiles.get(input.loserProfileId);
    if (row !== undefined) row.mergedInto = input.winnerProfileId;
  }

  public async recordMerge(record: MergeRecord): Promise<void> {
    this.merges.push(record);
  }

  public async recordLink(record: LinkRecord): Promise<void> {
    // Idempotent on `linkId`, the way the primary key makes the real
    // write idempotent — a re-seen pair is not new evidence.
    if (this.links.some((link) => link.linkId === record.linkId)) return;
    this.links.push(record);
  }

  /** Seed a profile that already exists, for the merge and cap cases. */
  public seedProfile(row: {
    profileId: string;
    firstSeenAt: Date;
    canonicalCustomerId?: string | null;
    traits?: Record<string, unknown>;
    traitsVersion?: number;
  }): void {
    this.profiles.set(row.profileId, {
      profileId: row.profileId,
      canonicalCustomerId: row.canonicalCustomerId ?? null,
      traits: row.traits ?? {},
      traitsVersion: row.traitsVersion ?? 0,
      mergedInto: null,
      firstSeenAt: row.firstSeenAt,
    });
  }

  public seedBinding(scope: GraphScope, kind: string, value: string, profileId: string): void {
    this.bindings.set(scopedKey(scope, kind, value), profileId);
  }
}
