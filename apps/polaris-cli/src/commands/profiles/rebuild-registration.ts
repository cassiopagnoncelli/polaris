/**
 * Constructing the real rebuild driver for the registered command.
 *
 * Split from `rebuild.ts` so the ordering logic stays testable without a
 * database, a broker, or a resolver — those are exactly the dependencies
 * this file introduces.
 *
 * ## Replay reuses the replay COMMANDS, not their internals
 *
 * `executeReplay` needs a plan, a stream source, a producer and a store,
 * all built by `replay execute`'s own bootstrap. Reaching past the command
 * to call the executor directly would duplicate that bootstrap and, worse,
 * skip the command's refusals and its audit row — a rebuild would replay
 * under weaker guarantees than an operator running the same replay by hand.
 *
 * So it drives `replay create` and then `replay execute`, and gets the job
 * id between them through the `issueId` hook `create` already exposes for
 * tests. One seam, already there, doing what it was shaped for.
 */

import type { CommandContext } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { archiveEarliestDate, archiveFloorInstant } from "../replay/archive-io.js";
import { buildReplayCreateRunner } from "../replay/create.js";
import { buildReplayExecuteRunner } from "../replay/execute.js";
import { generateReplayJobId } from "../replay/id.js";
import type { ProfilesRebuildDriver, RebuildJob } from "./rebuild.js";
import { createMetricsDrainProbe, createRebuildDriver } from "./rebuild-driver.js";

/**
 * Where the resolver publishes `polaris_processor_in_flight`.
 *
 * Required, with no default. A default would let a rebuild run against
 * whatever happened to answer on localhost, and the one thing this probe
 * must never do is report "drained" because it asked the wrong process.
 */
const METRICS_URL_ENV = "POLARIS_RESOLVER_METRICS_URL";

/**
 * How far back `raw.events` is retained. Bounds the rebuild's depth, and is
 * REPORTED rather than assumed — see the runbook.
 */
const RETENTION_ENV = "POLARIS_RABBITMQ_STREAM_RETENTION_DAYS";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

export function buildRegisteredRebuildDriver(
  ctx: CommandContext,
  scope: { readonly projectId: string; readonly environment: string; readonly reason: string },
): ProfilesRebuildDriver {
  const metricsUrl = ctx.env[METRICS_URL_ENV];
  if (metricsUrl === undefined || metricsUrl.trim().length === 0) {
    throw new UsageError(
      `${METRICS_URL_ENV} is required: the rebuild waits for the resolver to drain before ` +
        "truncating, and without the resolver's metrics endpoint it cannot tell a busy stage " +
        "from a quiet one. See docs/operations/runbook-profile-rebuild.md",
    );
  }
  const retentionDays = Number.parseInt(ctx.env[RETENTION_ENV] ?? "90", 10);

  const handle = connectDb({ env: ctx.env });

  return createRebuildDriver({
    db: handle.db,
    actor: { source: ctx.actor.source, label: ctx.actor.label },
    reason: scope.reason,
    generateAuditId: () => `polaris_aud_${generateReplayJobId()}`,
    now: () => new Date(),
    retentionDays: Number.isFinite(retentionDays) ? retentionDays : 90,
    inFlightResolutions: createMetricsDrainProbe({ metricsUrl }),
    runReplay: async ({ projectId, environment }) => {
      // The window is computed here, not left to a mode word. An earlier
      // version passed `mode: "full"` and no window at all, which `replay
      // create` rejects on its first line — `--from is required` — so the
      // rebuild could never have reached the executor.
      const now = new Date();
      const earliestArchived = archiveFloorInstant(
        await archiveEarliestDate({ env: ctx.env, projectId, environment }),
      );
      const retentionFloor = new Date(
        now.getTime() - (Number.isFinite(retentionDays) ? retentionDays : 90) * MILLIS_PER_DAY,
      );
      // As deep as anything can reach. Replaying a narrower window would
      // leave the profile plane reflecting part of the history, which is
      // worse than the over-merge the rebuild was called to fix.
      const from =
        earliestArchived !== null && earliestArchived.getTime() < retentionFloor.getTime()
          ? earliestArchived
          : retentionFloor;

      // `create` mints the id; capturing it through the hook is how the two
      // commands are chained without either learning about the other.
      let replayJobId = "";
      await buildReplayCreateRunner({
        issueId: () => {
          replayJobId = generateReplayJobId();
          return replayJobId;
        },
      })(
        {
          project: projectId,
          env: environment,
          target: "processor",
          from: from.toISOString(),
          to: now.toISOString(),
          mode: "live",
          reason: `profile rebuild: ${scope.reason}`,
        },
        ctx,
      );
      await buildReplayExecuteRunner()({ replayJobId }, ctx);
      return {
        depthBoundedBy: from === earliestArchived ? "archive" : "raw_events_retention",
        earliestReplayed: from.toISOString(),
      };
    },
    recordJob: async (job: RebuildJob) => {
      // Logged rather than tabled: there is no `rebuild_jobs` table, and
      // adding one to carry a handful of rows a year would be schema for
      // its own sake. The audit rows from pause/truncate/resume already
      // carry the durable trail; this line is what ties them together under
      // one job id.
      ctx.logger.info({ audit_action: "profiles.rebuild", ...job }, "profile rebuild finished");
    },
  });
}
