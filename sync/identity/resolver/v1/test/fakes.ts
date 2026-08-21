/**
 * An in-memory profile store for the identity-stage tests.
 *
 * It used to be a second implementation of resolution semantics — 180
 * lines mirroring find-or-create, eager repointing, the per-kind cap and
 * the merge-rate breaker — which meant the golden fixtures were evidence
 * about the fake rather than about the stage. When the physics moved to
 * `@polaris/identity-graph`, this became what it should always have
 * been: a STORE. `resolveIdentity` is the same function production runs;
 * only the rows live in Maps.
 *
 * Deliberately the stricter store where the two could differ: bindings
 * are a map keyed the way the primary key is, so a test that would only
 * pass against a looser store fails here too.
 */

import type {
  GraphProfile,
  GraphScope,
  IdentifierBinding,
  IdentityGraphStore,
  LinkRecord,
  MergeRecord,
} from "@polaris/identity-graph";
import { resolveIdentity } from "@polaris/identity-graph";
import type { Logger } from "@polaris/observability-logger";
import type { ProfileRepository, ResolutionResult, ResolveInput } from "@polaris/profiles";

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

export class InMemoryProfileRepository implements ProfileRepository, IdentityGraphStore {
  private readonly profiles = new Map<string, ProfileRow>();
  /** `${project}|${env}|${kind}|${value}` -> profileId */
  private readonly identifiers = new Map<string, string>();
  private readonly merges: MergeRecord[] = [];
  private readonly links: LinkRecord[] = [];
  private idCounter = 0;

  public constructor(private readonly idFactory?: () => string) {}

  public async resolveProfile(input: ResolveInput): Promise<ResolutionResult> {
    return resolveIdentity(this, input);
  }

  // ---- IdentityGraphStore ------------------------------------------------

  /**
   * Zero-padded, per-instance ids. Padding matters: the merge tiebreak is
   * "lower id" by STRING comparison (uuidv7 in production), and unpadded
   * counters invert it at the 9→10 boundary — `"prof_10" < "prof_9"` —
   * which would flip the winner depending on how many profiles earlier
   * tests happened to create.
   */
  public newId(): string {
    if (this.idFactory !== undefined) return this.idFactory();
    this.idCounter += 1;
    return `prof_${String(this.idCounter).padStart(6, "0")}`;
  }

  public async lockIdentifier(): Promise<void> {
    // Nothing to serialize in a single-threaded fake; the ORDER locks are
    // taken in is asserted where it matters, in the graph's own suite.
  }

  public async findBindings(
    scope: GraphScope,
    identifiers: readonly { readonly kind: string; readonly value: string }[],
  ): Promise<readonly IdentifierBinding[]> {
    const found: IdentifierBinding[] = [];
    for (const identifier of identifiers) {
      const profileId = this.identifiers.get(scopedKey(scope, identifier.kind, identifier.value));
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
    traits: Record<string, unknown>;
    firstSeenAt: Date;
  }): Promise<void> {
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
    const row = this.profiles.get(input.profileId);
    if (row === undefined) return;
    row.canonicalCustomerId = input.canonicalCustomerId;
    row.traits = input.traits;
    row.traitsVersion = input.traitsVersion;
  }

  public async countBindingsOfKind(profileId: string, kind: string): Promise<number> {
    return [...this.identifiers.entries()].filter(
      ([key, value]) => value === profileId && key.split("|")[2] === kind,
    ).length;
  }

  public async touchBinding(): Promise<void> {
    // `last_seen_at` only; nothing this suite reads.
  }

  public async bindIdentifier(input: {
    scope: GraphScope;
    kind: string;
    value: string;
    profileId: string;
  }): Promise<void> {
    this.identifiers.set(scopedKey(input.scope, input.kind, input.value), input.profileId);
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
    for (const [key, value] of this.identifiers.entries()) {
      if (value === input.fromProfileId) {
        this.identifiers.set(key, input.toProfileId);
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
    if (this.links.some((link) => link.linkId === record.linkId)) return;
    this.links.push(record);
  }

  // ---- assertions the suite reads ---------------------------------------

  public getProfile(profileId: string): ProfileRow | undefined {
    return this.profiles.get(profileId);
  }

  public resolveIdentifier(
    projectId: string,
    environment: string,
    kind: string,
    value: string,
  ): string | undefined {
    return this.identifiers.get(`${projectId}|${environment}|${kind}|${value}`);
  }

  public get profileCount(): number {
    return [...this.profiles.values()].filter((p) => p.mergedInto === null).length;
  }
}

/** Records every publish so tests can assert on families and payloads. */
export class RecordingProducer {
  public readonly published: Array<{
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }> = [];

  public async publishEvent(input: {
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }): Promise<unknown> {
    this.published.push(input);
    return undefined;
  }

  public eventsOn(family: string): Array<Record<string, unknown>> {
    return this.published.filter((p) => p.family === family).map((p) => p.event);
  }

  public names(family: string): string[] {
    return this.eventsOn(family).map((e) => String(e["event"]));
  }
}

export const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;
