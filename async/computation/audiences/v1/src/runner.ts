/**
 * The audiences runner.
 *
 * One pass per `(project, environment)`: evaluate each definition, diff the
 * resulting population against stored membership, write only the changes,
 * and emit one event per transition.
 *
 * What an audience MEANS — the predicate, the population a definition
 * selects, which membership changes count as signals — is
 * `@polaris/engage-audiences`, and it is pure. This file is the runtime
 * around it: it holds the four seams, asks the library to decide, and
 * performs the decision in the order the decision requires.
 *
 * ## Why a cron job and not a consumer
 *
 * The same argument the traits runner makes, one layer up. An audience over
 * `orders_30d` changes when an order lands AND when one ages out; the
 * second has no event to react to. And since audiences read traits, and
 * traits are themselves computed on a schedule, a streaming audience
 * evaluator would be reacting to a source that only moves on a cron
 * anyway — all of the complexity, none of the freshness.
 *
 * Ordering follows: audiences run AFTER traits. Running them in the same
 * scheduled window against yesterday's traits is not wrong, only stale by
 * one cycle; `infra/backups/crontab.example` staggers them accordingly.
 *
 * ## The runner does not read raw events, ever
 *
 * A `traits` audience reads the profile store. A `projection` audience runs
 * SQL held to the same table allowlist as trait SQL by
 * `scripts/lint-trait-sql.mjs`. There is no third path, and neither of the
 * two can reach `analytics_raw`.
 *
 * ## Writes and emissions are per transition
 *
 * A run over an unchanged population performs no writes and publishes
 * nothing. That is what makes a re-run free and the command lock-free.
 */

import type { AudienceDefinition } from "@polaris/audience-catalog";
import { traitsReferenced } from "@polaris/audience-catalog";
import {
  type AudienceSummary,
  type AudienceTransition,
  membersMatching,
  planAudience,
  type StampedMembership,
  type TraitBag,
} from "@polaris/engage-audiences";

/** Reads a projection-sourced audience's SQL against the warehouse. */
export interface AudienceQueryRunner {
  run(input: {
    readonly sql: string;
    readonly projectId: string;
    readonly environment: string;
  }): Promise<ReadonlyArray<{ readonly profile_id: string }>>;
}

/** The profile store, narrowed to what audience evaluation needs. */
export interface AudienceProfileStore {
  /**
   * Every profile carrying a value for any of `keys`, with those traits.
   *
   * Scoped to the keys the predicate reads rather than the whole store:
   * the population a trait-sourced audience can possibly contain is
   * bounded by who has the traits it names.
   */
  profilesWithTraits(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly keys: readonly string[];
  }): Promise<ReadonlyArray<{ readonly profileId: string; readonly traits: TraitBag }>>;
}

/** Membership state. The only thing this runner writes. */
export interface AudienceMembershipStore {
  /** Every stored row for one audience in one scope, open and closed. */
  listMemberships(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
  }): Promise<readonly StampedMembership[]>;
  /** Open a membership (insert, or reopen an exited row). */
  enter(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
    readonly audienceVersion: number;
    readonly profileId: string;
  }): Promise<{ readonly enteredAt: Date }>;
  /** Close an open membership. */
  exit(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
    readonly audienceVersion: number;
    readonly profileId: string;
  }): Promise<void>;
  /**
   * Update the version stamp on rows that stayed members.
   *
   * Separate from `enter` because it must NOT touch `entered_at`: a
   * restamped row is the same membership, and moving its start would
   * corrupt the dwell time `audience.exited` reports later.
   */
  restamp(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
    readonly audienceVersion: number;
    readonly profileIds: readonly string[];
  }): Promise<void>;
}

/** Emits the two transition events. */
export interface AudienceEmitter {
  entered(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
    readonly audienceVersion: number;
    readonly profileId: string;
    readonly reEntry: boolean;
    readonly runId: string;
  }): Promise<void>;
  exited(input: {
    readonly projectId: string;
    readonly environment: string;
    readonly audience: string;
    readonly audienceVersion: number;
    readonly profileId: string;
    readonly enteredAt: Date;
    readonly runId: string;
  }): Promise<void>;
}

export interface AudienceRunInput {
  readonly projectId: string;
  readonly environment: string;
  readonly audiences: readonly AudienceDefinition[];
  readonly profiles: AudienceProfileStore;
  readonly memberships: AudienceMembershipStore;
  readonly emitter: AudienceEmitter;
  /** Required only when a `projection` audience is in the set. */
  readonly query?: AudienceQueryRunner;
  readonly runId: string;
}

export interface AudienceRunResult {
  readonly perAudience: readonly AudienceSummary[];
  readonly transitions: number;
}

export async function runAudiences(input: AudienceRunInput): Promise<AudienceRunResult> {
  const perAudience: AudienceSummary[] = [];
  let transitions = 0;

  for (const definition of input.audiences) {
    const desired = await computePopulation(definition, input);

    const stored = await input.memberships.listMemberships({
      projectId: input.projectId,
      environment: input.environment,
      audience: definition.key,
    });

    const plan = planAudience({ definition, desired, stored });

    for (const transition of plan.transitions) {
      await applyTransition(transition, definition, input);
    }

    if (plan.restamp.length > 0) {
      // No events: the membership did not change, only the definition
      // version that last confirmed it.
      await input.memberships.restamp({
        projectId: input.projectId,
        environment: input.environment,
        audience: definition.key,
        audienceVersion: definition.version,
        profileIds: plan.restamp,
      });
    }

    transitions += plan.transitions.length;
    perAudience.push(plan.summary);
  }

  return { perAudience, transitions };
}

/**
 * The population, by whichever of the two routes the definition declares.
 *
 * The projection route is I/O and stays here; the trait route hands the
 * rows it fetched to the library, which decides who among them qualifies.
 * `traitsReferenced` is what bounds the fetch, and it is the catalog's so
 * that the narrowing is stated once, beside the predicate it narrows.
 */
async function computePopulation(
  definition: AudienceDefinition,
  input: AudienceRunInput,
): Promise<ReadonlySet<string>> {
  if (definition.source === "projection") {
    if (input.query === undefined) {
      throw new Error(
        `audience '${definition.key}' is projection-sourced but no query runner was supplied`,
      );
    }
    const rows = await input.query.run({
      sql: definition.sql,
      projectId: input.projectId,
      environment: input.environment,
    });
    return new Set(rows.map((row) => row.profile_id));
  }

  const profiles = await input.profiles.profilesWithTraits({
    projectId: input.projectId,
    environment: input.environment,
    keys: traitsReferenced(definition.predicate),
  });
  return membersMatching(definition.predicate, profiles);
}

/**
 * Write the membership change, then emit.
 *
 * Order matters and is not interchangeable. The store write is the
 * idempotence boundary: if the process dies between write and emit, the
 * next run sees the profile already a member and emits nothing, so a
 * transition is lost. Emitting first would instead risk announcing a
 * membership that was never recorded — and the next run, seeing no stored
 * row, would announce it a second time.
 *
 * A lost transition is recoverable (re-run after correcting the store, or
 * rebuild the vendor audience from `audience_memberships`); a duplicated or
 * phantom one has already reached a vendor. So the write goes first.
 */
async function applyTransition(
  transition: AudienceTransition,
  definition: AudienceDefinition,
  input: AudienceRunInput,
): Promise<void> {
  const scope = {
    projectId: input.projectId,
    environment: input.environment,
    audience: definition.key,
    audienceVersion: definition.version,
  };

  if (transition.kind === "entered") {
    await input.memberships.enter({ ...scope, profileId: transition.profileId });
    await input.emitter.entered({
      ...scope,
      profileId: transition.profileId,
      reEntry: transition.reEntry,
      runId: input.runId,
    });
    return;
  }

  await input.memberships.exit({ ...scope, profileId: transition.profileId });
  await input.emitter.exited({
    ...scope,
    profileId: transition.profileId,
    enteredAt: transition.enteredAt,
    runId: input.runId,
  });
}
