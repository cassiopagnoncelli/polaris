/**
 * The traits runner.
 *
 * One pass per `(project, environment)`: execute each definition against
 * ClickHouse projections, diff the results against what profiles currently
 * carry, write only the changes, and emit what happened.
 *
 * ## Why this is a cron job and not a consumer
 *
 * A trait is an aggregate over a window — "orders in the last 30 days"
 * changes when an order lands AND when one ages out. The second half has no
 * event to react to, so a streaming implementation would still need a timer
 * to catch expiries, and would then have two paths computing the same number
 * differently. One scheduled pass over the whole population is simpler and
 * is the only one of the two that can be reasoned about.
 *
 * ## The write is the shared store, not the ingester
 *
 * Decided on this card (see the plan's amended ownership line). The identity
 * stage remains the profile store's only SYNC writer; async trait
 * computation writes `traits` and `traits_version` and nothing else. The
 * rule exists so one writer decides WHO someone is — identifiers, merges,
 * canonical customer id — and traits are a disjoint column set that cannot
 * cause an identity split.
 *
 * ## Emissions
 *
 * `profile.updated` per changed profile, carrying the changed keys only,
 * and one `trait.computed` per definition per run. The asymmetry is
 * deliberate: the per-profile detail has readers (destinations, audiences),
 * and a per-profile `trait.computed` would put the same information on the
 * spine twice.
 */

import { diffTrait, mergeChanges, type TraitChange } from "./diff.js";

/** A trait definition, reduced to what the runner needs. */
export interface RunnableTrait {
  readonly key: string;
  readonly sql: string;
}

/** Reads a definition's SQL against the warehouse. */
export interface TraitQueryRunner {
  run(input: {
    readonly sql: string;
    readonly projectId: string;
    readonly environment: string;
  }): Promise<ReadonlyArray<{ readonly profile_id: string; readonly value: unknown }>>;
}

/** The profile store, narrowed to what an async trait writer may touch. */
export interface TraitProfileStore {
  /**
   * Current traits for every profile carrying any of `keys`.
   *
   * Scoped to the keys this run computes rather than every profile in the
   * project: the diff only needs profiles that hold a value for a trait
   * being recomputed, plus whoever the query returned.
   */
  profilesWithTraits(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly keys: readonly string[];
  }): Promise<
    ReadonlyArray<{
      readonly profileId: string;
      readonly traits: Readonly<Record<string, unknown>>;
    }>
  >;
  /**
   * Apply one profile's changes and return its new `traits_version`.
   *
   * One call per profile, one version bump per call — which is what makes
   * the version describe the profile rather than count computations.
   */
  applyTraitChange(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly change: TraitChange;
  }): Promise<{ readonly traitsVersion: number }>;
}

/** Emits the two events a run produces. */
export interface TraitEmitter {
  profileUpdated(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly profileId: string;
    readonly traitsVersion: number;
    readonly traits: Readonly<Record<string, unknown>>;
    readonly removedKeys: readonly string[];
    readonly runId: string;
  }): Promise<void>;
  traitComputed(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly traitKey: string;
    readonly computedCount: number;
    readonly changedCount: number;
    readonly removedCount: number;
    readonly durationMs: number;
    readonly runId: string;
  }): Promise<void>;
}

export interface TraitRunInput {
  readonly projectId: string;
  readonly environment: string;
  readonly traits: readonly RunnableTrait[];
  readonly query: TraitQueryRunner;
  readonly store: TraitProfileStore;
  readonly emitter: TraitEmitter;
  readonly runId: string;
  readonly now: () => number;
}

export interface TraitRunResult {
  readonly profilesChanged: number;
  readonly perTrait: ReadonlyArray<{
    readonly key: string;
    readonly computed: number;
    readonly changed: number;
    readonly removed: number;
  }>;
}

export async function runTraits(input: TraitRunInput): Promise<TraitRunResult> {
  const stored = await input.store.profilesWithTraits({
    projectId: input.projectId,
    environment: input.environment,
    keys: input.traits.map((trait) => trait.key),
  });

  const perTraitChanges: TraitChange[][] = [];
  const perTrait: TraitRunResult["perTrait"][number][] = [];

  for (const trait of input.traits) {
    const startedAt = input.now();
    const rows = await input.query.run({
      sql: trait.sql,
      projectId: input.projectId,
      environment: input.environment,
    });
    const computed = rows.map((row) => ({ profileId: row.profile_id, value: row.value }));
    const changes = diffTrait({ key: trait.key, computed, stored });
    perTraitChanges.push([...changes]);

    const removed = changes.filter((change) => change.remove.length > 0).length;
    perTrait.push({
      key: trait.key,
      computed: computed.length,
      changed: changes.length,
      removed,
    });

    // Per definition, per run — not per profile. See the module header.
    await input.emitter.traitComputed({
      projectId: input.projectId,
      environment: input.environment,
      traitKey: trait.key,
      computedCount: computed.length,
      changedCount: changes.length,
      removedCount: removed,
      durationMs: input.now() - startedAt,
      runId: input.runId,
    });
  }

  // Merged BEFORE writing, so three traits changing on one profile is one
  // write and one version bump rather than three of each.
  const merged = mergeChanges(perTraitChanges);

  for (const change of merged) {
    const { traitsVersion } = await input.store.applyTraitChange({
      projectId: input.projectId,
      environment: input.environment,
      change,
    });
    await input.emitter.profileUpdated({
      projectId: input.projectId,
      environment: input.environment,
      profileId: change.profileId,
      traitsVersion,
      traits: change.set,
      removedKeys: change.remove,
      runId: input.runId,
    });
  }

  return { profilesChanged: merged.length, perTrait };
}
