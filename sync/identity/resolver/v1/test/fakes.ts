/**
 * In-memory profile store for the identity-stage tests.
 *
 * Mirrors the semantics `repository.ts` implements against Postgres —
 * find-or-create, eager merge repointing, the per-kind cap and the
 * merge-rate breaker — so the behavioural suite can run without a
 * database. The Postgres implementation is exercised separately by the
 * migration probes and the integration path.
 *
 * Where the two could drift, this fake is deliberately the STRICTER one:
 * it enforces the identifier uniqueness the primary key enforces, so a
 * test that would only pass against a looser store fails here too.
 */

import type { Logger } from "@polaris/shared-logger";

import type { ProfileRepository, ResolutionResult, ResolveInput } from "../src/repository.js";

interface ProfileRow {
  profileId: string;
  canonicalCustomerId: string | null;
  traits: Record<string, unknown>;
  traitsVersion: number;
  mergedInto: string | null;
  firstSeenAt: Date;
}

interface MergeRow {
  winnerProfileId: string;
  mergedAt: Date;
}

export class InMemoryProfileRepository implements ProfileRepository {
  private readonly profiles = new Map<string, ProfileRow>();
  /** `${project}|${env}|${kind}|${value}` -> profileId */
  private readonly identifiers = new Map<string, string>();
  private readonly merges: MergeRow[] = [];
  private sequence = 0;
  private idCounter = 0;

  public constructor(private readonly idFactory?: () => string) {}

  /**
   * Zero-padded, per-instance ids. Padding matters: the merge tiebreak is
   * "lower id" by STRING comparison (uuidv7 in production), and unpadded
   * counters invert it at the 9→10 boundary — `"prof_10" < "prof_9"` —
   * which would flip the winner depending on how many profiles earlier
   * tests happened to create.
   */
  private nextId(): string {
    if (this.idFactory !== undefined) return this.idFactory();
    this.idCounter += 1;
    return `prof_${String(this.idCounter).padStart(6, "0")}`;
  }

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

  public async resolveProfile(input: ResolveInput): Promise<ResolutionResult> {
    if (input.identifiers.length === 0) {
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

    const keyOf = (kind: string, value: string): string =>
      `${input.projectId}|${input.environment}|${kind}|${value}`;

    const matched = new Map<string, string>();
    for (const id of input.identifiers) {
      const existing = this.identifiers.get(keyOf(id.kind, id.value));
      if (existing !== undefined) matched.set(keyOf(id.kind, id.value), existing);
    }
    const distinct = [...new Set(matched.values())].sort();

    let profileId: string;
    let kind: ResolutionResult["kind"];
    let merge: ResolutionResult["merge"] = null;

    if (distinct.length === 0) {
      profileId = this.nextId();
      this.profiles.set(profileId, {
        profileId,
        canonicalCustomerId: null,
        traits: {},
        traitsVersion: 0,
        mergedInto: null,
        firstSeenAt: input.now,
      });
      kind = "created";
    } else if (distinct.length === 1) {
      profileId = distinct[0] as string;
      kind = "bound";
    } else {
      // Winner is the older profile; ties broken by the lower id, so a
      // replay picks the same winner rather than shuffling.
      const rows = distinct
        .map((id) => this.profiles.get(id))
        .filter((r): r is ProfileRow => r !== undefined)
        .sort((a, b) =>
          a.firstSeenAt.getTime() !== b.firstSeenAt.getTime()
            ? a.firstSeenAt.getTime() - b.firstSeenAt.getTime()
            : a.profileId < b.profileId
              ? -1
              : 1,
        );
      const winner = rows[0] as ProfileRow;
      const loser = rows[1] as ProfileRow;

      const windowStart = new Date(input.now.getTime() - input.policy.mergeWindowSeconds * 1000);
      const recent = this.merges.filter(
        (m) => m.winnerProfileId === winner.profileId && m.mergedAt >= windowStart,
      ).length;

      if (recent >= input.policy.maxMergesPerWindow) {
        // Mirrors the real repository's early return: a suspended merge
        // binds NOTHING — moving the event's identifiers to the winner
        // would be the merge — so identifiers stay where they were and
        // the canonical customer id cannot change. Traits still patch.
        const winnerRow = this.profiles.get(winner.profileId) as ProfileRow;
        let suspendedTraitsPatched = false;
        if (input.traits !== null) {
          winnerRow.traits = { ...winnerRow.traits, ...input.traits };
          winnerRow.traitsVersion += 1;
          suspendedTraitsPatched = true;
        }
        return {
          kind: "bound",
          profileId: winner.profileId,
          canonicalCustomerId: winnerRow.canonicalCustomerId,
          traitsVersion: winnerRow.traitsVersion,
          bound: [],
          merge: null,
          rejected: [],
          mergeSuspended: { profileId: winner.profileId, mergeCount: recent },
          traitsPatched: suspendedTraitsPatched,
        };
      }

      let moved = 0;
      for (const [k, v] of this.identifiers.entries()) {
        if (v === loser.profileId) {
          this.identifiers.set(k, winner.profileId);
          moved += 1;
        }
      }
      loser.mergedInto = winner.profileId;
      this.merges.push({ winnerProfileId: winner.profileId, mergedAt: input.now });
      merge = {
        mergeId: `merge_${++this.sequence}`,
        winnerProfileId: winner.profileId,
        loserProfileId: loser.profileId,
        identifiersMoved: moved,
      };
      profileId = winner.profileId;
      kind = "merged";
    }

    // Bind, enforcing the per-kind cap.
    const bound: ResolutionResult["bound"] = [];
    const rejected: ResolutionResult["rejected"] = [];
    for (const id of input.identifiers) {
      const current = this.identifiers.get(keyOf(id.kind, id.value));
      if (current === profileId) {
        (bound as { kind: string; value: string; newlyBound: boolean }[]).push({
          ...id,
          newlyBound: false,
        });
        continue;
      }
      const countOfKind = [...this.identifiers.entries()].filter(
        ([k, v]) => v === profileId && k.split("|")[2] === id.kind,
      ).length;
      if (countOfKind >= input.policy.maxIdentifiersPerKind) {
        (
          rejected as {
            kind: string;
            value: string;
            reason: string;
            existingBindingCount: number;
          }[]
        ).push({ ...id, reason: "identifier_cap", existingBindingCount: countOfKind });
        continue;
      }
      this.identifiers.set(keyOf(id.kind, id.value), profileId);
      (bound as { kind: string; value: string; newlyBound: boolean }[]).push({
        ...id,
        newlyBound: true,
      });
    }

    const row = this.profiles.get(profileId) as ProfileRow;
    // Canonical mirrors the repository's rule: picked from what actually
    // BOUND, never from the raw input, so a cap-refused customer_id does
    // not become a canonical id whose identifier resolves elsewhere.
    const customer = bound.find((b) => b.kind === "customer_id")?.value;
    if (customer !== undefined) row.canonicalCustomerId = customer;
    let traitsPatched = false;
    if (input.traits !== null) {
      row.traits = { ...row.traits, ...input.traits };
      row.traitsVersion += 1;
      traitsPatched = true;
    }

    return {
      kind,
      profileId,
      canonicalCustomerId: row.canonicalCustomerId,
      traitsVersion: row.traitsVersion,
      bound,
      merge,
      rejected,
      mergeSuspended: null,
      traitsPatched,
    };
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
