/**
 * The real `ProfilesRebuildDriver`.
 *
 * `rebuild.ts` owns the ORDER and the refusals; this owns what each step
 * actually does. Kept apart because the ordering is the part with the
 * subtle failure modes and it deserves tests that do not need a database.
 *
 * ## pause and resume are the resolver's activation gate
 *
 * `sync-identity` is the component, not `identity-resolver` — the legacy
 * processor keeps running through the M6 retirement and the two have
 * separate activation rows on purpose. Pausing the wrong one would leave
 * the spine writing profiles into a scope being emptied, which is the exact
 * race the ordering exists to prevent.
 *
 * ## The drain is a wait, not an assumption
 *
 * Flipping the activation row stops the resolver picking up NEW work. It
 * says nothing about the messages already in flight, and those are precisely
 * the ones that would write into the truncated scope. So the pause polls
 * until the resolver reports no in-flight resolutions for the scope, with a
 * ceiling — a drain that never completes is a stuck consumer, and blocking
 * forever would turn that into a rebuild that appears hung rather than one
 * that reports why it stopped.
 *
 * ## replay is a job, not a call
 *
 * The existing replay subsystem creates a plan and executes it. The rebuild
 * does not reimplement either; it creates a project-scoped job and waits.
 * That also means a rebuild inherits replay's own guarantees about
 * checkpoints and chunking rather than inventing weaker ones.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";

import type { AuditActorSource, ProcessorActivationRow } from "../../db/index.js";
import {
  disableProcessorActivationWithAudit,
  enableProcessorActivationWithAudit,
  findActivationByKey,
  truncateProfilePlaneWithAudit,
} from "../../db/index.js";
import type { ProfilesRebuildDriver, RebuildJob } from "./rebuild.js";

/** The spine's identity stage. NOT `identity-resolver`, the legacy one. */
export const RESOLVER_COMPONENT = "sync-identity" as const;
export const RESOLVER_VERSION = "v1" as const;

/** How long the pause waits for in-flight resolutions to drain. */
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 500;

export interface RebuildDriverDeps {
  readonly db: Kysely<Database>;
  readonly actor: { readonly source: AuditActorSource; readonly label: string };
  readonly reason: string;
  readonly generateAuditId: () => string;
  readonly now: () => Date;
  /**
   * How far back `raw.events` reaches, in days. Reported on the job so an
   * operator learns the rebuild's depth rather than assuming it is complete.
   */
  readonly retentionDays: number;
  /** Creates and awaits a project-scoped replay. */
  readonly runReplay: (input: {
    readonly projectId: string;
    readonly environment: string;
  }) => Promise<void>;
  /**
   * In-flight resolutions for the scope. Zero means drained.
   *
   * `createMetricsDrainProbe` builds one from the resolver's own
   * `/metrics`. Injectable because the alternative sources are all worse
   * and someone will be tempted: a fixed sleep is a guess, and
   * `processor_runs` tracks batch runs rather than streaming work — it
   * would report zero for a resolver mid-flight on a hundred messages and
   * the truncate would race exactly what the drain excludes.
   */
  readonly inFlightResolutions: (input: {
    readonly projectId: string;
    readonly environment: string;
  }) => Promise<number>;
  readonly recordJob: (job: RebuildJob) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createRebuildDriver(deps: RebuildDriverDeps): ProfilesRebuildDriver {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const audit = (): {
    auditId: string;
    actorSource: AuditActorSource;
    actorLabel: string;
    reason: string;
    occurredAt: Date;
  } => ({
    auditId: deps.generateAuditId(),
    actorSource: deps.actor.source,
    actorLabel: deps.actor.label,
    reason: deps.reason,
    occurredAt: deps.now(),
  });

  // Snake_case: the key mirrors the table's columns, not the CLI's argument
  // style.
  const activationKey = (projectId: string, environment: string) => ({
    processor_name: RESOLVER_COMPONENT,
    processor_version: RESOLVER_VERSION,
    project_id: projectId,
    environment,
  });

  async function existing(
    projectId: string,
    environment: string,
  ): Promise<ProcessorActivationRow | null> {
    return findActivationByKey(deps.db, activationKey(projectId, environment));
  }

  return {
    async pause({ projectId, environment }): Promise<void> {
      await disableProcessorActivationWithAudit(
        deps.db,
        {
          key: activationKey(projectId, environment),
          existing: await existing(projectId, environment),
          changedBy: deps.actor.label,
        },
        audit(),
      );

      // The gate stops NEW work. These are the messages already in flight,
      // and they are the ones that would write into the scope about to be
      // emptied.
      const deadline = deps.now().getTime() + DRAIN_TIMEOUT_MS;
      for (;;) {
        const inFlight = await deps.inFlightResolutions({ projectId, environment });
        if (inFlight === 0) return;
        if (deps.now().getTime() >= deadline) {
          // Refusing here leaves the resolver paused and the plane intact,
          // which is the recoverable state — the caller resumes in its
          // `finally`. Truncating anyway would race exactly the writes this
          // wait exists to exclude.
          throw new Error(
            `resolver did not drain within ${String(DRAIN_TIMEOUT_MS)}ms ` +
              `(${String(inFlight)} resolutions still in flight for ${projectId}/${environment}); ` +
              "the profile plane was NOT truncated",
          );
        }
        await sleep(DRAIN_POLL_MS);
      }
    },

    async truncate({ projectId, environment }): Promise<void> {
      await truncateProfilePlaneWithAudit(deps.db, { projectId, environment }, audit());
    },

    async replay({ projectId, environment }): Promise<{ retentionDays: number }> {
      await deps.runReplay({ projectId, environment });
      return { retentionDays: deps.retentionDays };
    },

    async resume({ projectId, environment }): Promise<void> {
      await enableProcessorActivationWithAudit(
        deps.db,
        {
          key: activationKey(projectId, environment),
          existing: await existing(projectId, environment),
          changedBy: deps.actor.label,
        },
        audit(),
      );
    },

    recordJob: deps.recordJob,
  };
}

/**
 * A drain probe that reads the resolver's own in-flight gauge.
 *
 * `polaris_processor_in_flight` is published by `sync-identity` around every
 * handler invocation — incremented before, decremented in a `finally` so a
 * throwing handler still releases its count. Scraping it is the only source
 * that answers the question the drain actually asks.
 *
 * A scrape failure is NOT treated as zero. An unreachable resolver is
 * indistinguishable from a busy one from here, and reading "cannot tell" as
 * "drained" would truncate into whatever it is still doing. Throwing leaves
 * the recoverable state: paused, plane intact, resumed by the caller.
 */
export function createMetricsDrainProbe(input: {
  readonly metricsUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): (scope: { projectId: string; environment: string }) => Promise<number> {
  const doFetch = input.fetch ?? globalThis.fetch;
  return async (scope) => {
    const response = await doFetch(input.metricsUrl);
    if (!response.ok) {
      throw new Error(
        `resolver /metrics returned ${String(response.status)}; cannot confirm the stage has ` +
          "drained, so the profile plane was NOT truncated",
      );
    }
    return sumInFlight(await response.text(), scope);
  };
}

/**
 * Sum `polaris_processor_in_flight` across the series matching a scope.
 *
 * Summed rather than taking one series because a stage may be labelled per
 * topic family or partition; any one of those being non-zero means work is
 * still landing in the scope.
 */
export function sumInFlight(
  prometheusText: string,
  scope: { projectId: string; environment: string },
): number {
  let total = 0;
  for (const line of prometheusText.split("\n")) {
    if (!line.startsWith("polaris_processor_in_flight{")) continue;
    if (!line.includes(`project_id="${scope.projectId}"`)) continue;
    if (!line.includes(`environment="${scope.environment}"`)) continue;
    const value = Number.parseFloat(line.slice(line.lastIndexOf("}") + 1).trim());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
