/**
 * `polaris replay execute <replay_job_id> [--target-topic <name>]
 *   [--dry-run-emit]` — mutating.
 *
 * Picks up a replay-job row, derives its plan via `@polaris/shared-replay`,
 * and runs the executor against an injected source/producer/store. The
 * default executor is wired against the real transport: a stream
 * range-reader per partition and a confirmed producer for the
 * republish. Tests inject in-memory adapters so the lifecycle assertions
 * do not need a broker.
 *
 * Architectural rules baked into this command:
 *
 *   - **Refuses dry-run jobs.** A row whose `mode` is `dry_run` returns a
 *     planner that the executor refuses to ship; the CLI surfaces the
 *     `replay_executor_refused:plan_is_dry_run` error before any
 *     producer is touched.
 *
 *   - **Refuses planner-shaped flags.** The same `rejectReplayPlanArguments`
 *     gate the rest of the replay group uses fires before any plan
 *     derivation or executor wiring. A future caller cannot smuggle a
 *     planner-internal flag through the execute surface.
 *
 *   - **Threads the operator label.** The CLI passes
 *     `ctx.actor.label` to the executor's logger payload so worker logs
 *     attribute the run to the operator. The audit row trail still lives
 *     in the operator-issued `replay create` / `replay cancel`
 *     transitions (P7-001) — the executor's lifecycle moves are
 *     operationally derivable from the row's timestamps + counters.
 *
 *   - **The CLI is responsible for closing the producer / consumer**
 *     after the executor returns. The store adapter exposes a
 *     `close()` so the underlying Kysely handle disconnects even when
 *     the executor throws.
 *
 * `mutates: true`: routes through the P6-007 production gate.
 *
 * @see packages/shared-replay/src/executor.ts
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-003-processor-replay-executor.md
 */

import {
  loadConfigWithDefaults,
  partitionsForFamily,
  rabbitmqEnvSchema,
} from "@polaris/shared-config";
import {
  DEFAULT_RETENTION_DAYS,
  type ExecuteReplayOutcome,
  executeReplay,
  planReplay,
  ReplayExecutorError,
  type ReplayExecutorLogger,
  type ReplayExecutorProducer,
  type ReplayExecutorSource,
  type ReplayExecutorStore,
  type ReplayJobDeclaration,
  type ReplayPlan,
  ReplayPlanError,
  topicFamilyReachesDestinations,
} from "@polaris/shared-replay";
import {
  createAmqpStreamRangeDriver,
  createPolarisProducer,
  createTransportConnection,
  type PolarisProducer,
  STREAM_FAMILY_RAW_EVENTS,
} from "@polaris/shared-transport";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import type { AuditActorSource } from "../../db/index.js";
import {
  completeReplayJob,
  connectDb,
  failReplayJob,
  findReplayJobById,
  type ReplayJobRow,
  recordReplayChunkProgress,
  startReplayExecutionWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";
import { buildArchiveReplaySource, buildMixedReplaySource } from "./archive-adapters.js";
import {
  ARCHIVE_BUCKET_ENV,
  type ArchiveCoverageLookup,
  type ArchiveIo,
  archiveEarliestDate,
  buildArchiveIo,
} from "./archive-io.js";
import { buildStreamReplayProducer, buildStreamReplaySource } from "./stream-adapters.js";
import { rejectReplayPlanArguments } from "./validation.js";

interface ReplayExecuteArgs {
  readonly replayJobId: string;
  readonly targetTopic?: string;
}

/**
 * Store interface the CLI runner relies on. Production wires it to
 * Kysely + the new lifecycle setters (`markReplayJobRunning`,
 * `recordReplayChunkProgress`, `completeReplayJob`, `failReplayJob`).
 * Tests inject an in-memory implementation.
 */
export interface ReplayExecuteStore extends ReplayExecutorStore {
  findById(replayJobId: string): Promise<ReplayJobRow | null>;
  /**
   * Arm the audit row the subsequent `markRunning` will write in its own
   * transaction.
   *
   * Two-step because of ordering: the store has to exist before the row can
   * be fetched, and the row has to exist before the plan can be derived — but
   * the audit row wants the plan's facts. Writing it from the runner instead
   * would put it outside the status transition's transaction, which is the
   * one property that matters here.
   *
   * Implementations that do not audit (test doubles) may no-op.
   */
  armAudit(context: ReplayExecuteAuditContext): void;
  close(): Promise<void>;
}

/** What the `replay.execute` audit row records. */
export interface ReplayExecuteAuditContext {
  readonly row: ReplayJobRow;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly auditId: string;
  readonly occurredAt: Date;
  /** Topic the executor will publish to, after any --target-topic override. */
  readonly targetTopic: string;
  readonly reachesDestinations: boolean;
  readonly destinationsAcknowledged: boolean;
}

/**
 * Hooks the runner accepts so tests bypass the default transport / DB
 * wiring. Production omits everything except `now`, which the
 * dispatcher's clock hook supplies.
 */
export interface ReplayExecuteHooks {
  readonly openStore?: () => ReplayExecuteStore;
  readonly source?: (plan: ReplayPlan) => ReplayExecutorSource;
  /**
   * Oldest day the archive holds, or `null` for "no archive". Injected in
   * tests; production asks the bucket.
   */
  readonly archiveCoverage?: ArchiveCoverageLookup;
  readonly producer?: () => ReplayExecutorProducer;
  readonly now?: () => Date;
  /**
   * Optional logger seam. When omitted, the runner builds a logger
   * adapter around `ctx.logger`.
   */
  readonly logger?: (ctx: CommandContext) => ReplayExecutorLogger;
}

export const replayExecuteCommand: CommandDefinition = {
  id: "replay.execute",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("execute <replay_job_id>")
      .description(
        [
          "Execute a replay job. Reads the row, derives the deterministic plan via",
          "@polaris/shared-replay, and runs the executor against an injected source",
          "and producer. The row's status transitions pending|planning -> running ->",
          "completed (or failed). The executor stamps the polaris-replay headers on",
          "every republished event so destinations apply the P7-004 guardrails.",
        ].join("\n"),
      )
      .option(
        "--target-topic <name>",
        "Override the topic the executor publishes to (defaults to the plan's source_topic_family).",
      );
    cmd.action(async (replayJobId: string, opts: { targetTopic?: string }, command: Command) => {
      const wrapped = deps.runCommand<ReplayExecuteArgs>(
        { id: "replay.execute", mutates: true },
        runReplayExecute,
      );
      const args: ReplayExecuteArgs = {
        replayJobId,
        ...(opts.targetTopic !== undefined ? { targetTopic: opts.targetTopic } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildReplayExecuteRunner(hooks: ReplayExecuteHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  // The transport I/O default is lazy: tests that inject both `hooks.source`
  // and `hooks.producer` never trigger a real RabbitMQ connection.
  const buildDefaultIo =
    hooks.source === undefined || hooks.producer === undefined ? buildDefaultTransportIo : null;

  return async function runner(args: ReplayExecuteArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    // Defense in depth: same flag-rejection gate the rest of the replay
    // group uses. The execute surface accepts ONLY `--target-topic`; any
    // attempt to smuggle a planner-shaped flag is refused here before
    // any store or plan derivation happens.
    rejectReplayPlanArguments(args as unknown as Record<string, unknown>);

    const id = args.replayJobId.trim();
    if (id.length === 0) {
      throw new UsageError("replay_job_id is required");
    }

    const store = openStore();
    const transportIo = buildDefaultIo ? buildDefaultIo() : null;
    let archiveIo: ArchiveIo | null = null;
    // Plan-aware. `source_kind` says which substrate holds the window, and
    // reading the wrong one is silent: a stream read of an archived window
    // returns nothing and looks exactly like a window with no events.
    const sourceFactory =
      hooks.source ??
      ((plan: ReplayPlan) => {
        if (transportIo === null) {
          throw new Error("replay execute runner: transport I/O unavailable");
        }
        if (plan.source_kind === "stream") return transportIo.source;

        const archive = archiveIo ?? buildArchiveIo(ctx.env);
        if (archive === null) {
          throw new UsageError(
            `replay job "${id}" needs the object-storage archive (source_kind=${plan.source_kind}) ` +
              `but ${ARCHIVE_BUCKET_ENV} is not set. Point the CLI at the same bucket ` +
              "async/warehouse/archiver/v1 writes to.",
          );
        }
        archiveIo = archive;
        const archiveSource = buildArchiveReplaySource({ archive: archive.source });
        if (plan.source_kind === "archive") return archiveSource;
        return buildMixedReplaySource({
          stream: transportIo.source,
          archive: archiveSource,
          retentionCutoff: new Date(
            nowFn().getTime() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          ),
        });
      });
    const producerFactory =
      hooks.producer ??
      (() => {
        if (transportIo === null) {
          throw new Error("replay execute runner: transport I/O unavailable");
        }
        return transportIo.producer;
      });
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`replay job "${id}" not found`);
      }

      // Derive the plan. If the row is malformed (window outside
      // retention, etc.) the planner rejects with a structured code;
      // surface it through the CLI's exit-code mapping the same way
      // `replay plan` does.
      const declaration = rowToDeclaration(row);
      // Ask the archive how far back it goes BEFORE planning. Without this
      // the planner rejects every window older than retention, which is
      // the bound the archive exists to lift — the source adapter below
      // would never be reached.
      const earliestArchived = await archiveEarliestDate({
        env: ctx.env,
        projectId: row.project_id,
        environment: row.environment,
        lookup: hooks.archiveCoverage,
        remember: (io) => {
          archiveIo = io;
        },
      });
      let derived: ReplayPlan;
      try {
        derived = planReplay(declaration, {
          now: nowFn(),
          ...(earliestArchived !== null ? { archiveEarliestDate: earliestArchived } : {}),
        });
      } catch (err) {
        if (err instanceof ReplayPlanError) {
          throw new UsageError(`replay_plan_rejected:${err.code}: ${err.message}`, {
            code: err.code,
            replay_job_id: id,
          });
        }
        throw err;
      }

      // The executor resolves the same default; recompute it here so the
      // audit row names the topic that will actually be written to.
      const targetTopic = args.targetTopic ?? derived.target_topic_family;
      store.armAudit({
        row,
        actorSource: ctx.actor.source,
        actorLabel: ctx.actor.label,
        auditId: `polaris_aud_${uuidv7()}`,
        occurredAt: nowFn(),
        targetTopic,
        reachesDestinations: topicFamilyReachesDestinations(targetTopic),
        destinationsAcknowledged: derived.destinations_enabled,
      });

      const source = sourceFactory(derived);
      const producer = producerFactory();
      const logger = hooks.logger?.(ctx) ?? buildLoggerAdapter(ctx);

      let outcome: ExecuteReplayOutcome;
      try {
        outcome = await executeReplay({
          plan: derived,
          source,
          producer,
          store,
          ...(args.targetTopic !== undefined ? { target_topic: args.targetTopic } : {}),
          now: nowFn,
          logger,
        });
      } catch (err) {
        if (err instanceof ReplayExecutorError) {
          throw new UsageError(`replay_executor_refused:${err.code}: ${err.message}`, {
            code: err.code,
            replay_job_id: id,
          });
        }
        throw err;
      }

      ctx.logger.info(
        {
          audit_action: "replay.execute",
          replay_job_id: outcome.replay_job_id,
          project_id: derived.project_id,
          environment: derived.environment,
          target: derived.target,
          processor_name: derived.processor_name,
          processor_version: derived.processor_version,
          outcome_status: outcome.status,
          events_replayed: outcome.events_replayed,
          events_failed: outcome.events_failed,
          chunks: outcome.chunks.length,
          started_at: outcome.started_at,
          finished_at: outcome.finished_at,
          actor: ctx.actor.label,
        },
        "replay execute finished",
      );

      emit(ctx, outcome);
    } finally {
      await store.close();
      if (transportIo) {
        await transportIo.close();
      }
    }
    return undefined;
  };
}

const runReplayExecute = buildReplayExecuteRunner();

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

function defaultStore(env: NodeJS.ProcessEnv): ReplayExecuteStore {
  const handle = connectDb({ env });
  let armed: ReplayExecuteAuditContext | null = null;
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    armAudit: (context) => {
      armed = context;
    },
    markRunning: async (input) => {
      if (armed === null) {
        // Unreachable through the runner, which always arms before executing.
        // Refusing beats silently starting a replay with no attribution.
        throw new Error("replay execute: markRunning called before armAudit");
      }
      // One transaction: the pending -> running transition and the audit row
      // that says who started it. `replay_jobs.created_by` records who
      // created the job, which is not necessarily who ran it.
      await startReplayExecutionWithAudit(
        handle.db,
        {
          row: armed.row,
          eventsPlanned: input.events_planned,
          targetTopic: armed.targetTopic,
          reachesDestinations: armed.reachesDestinations,
          destinationsAcknowledged: armed.destinationsAcknowledged,
        },
        {
          auditId: armed.auditId,
          actorSource: armed.actorSource,
          actorLabel: armed.actorLabel,
          requestId: armed.auditId,
          occurredAt: input.now,
        },
      );
      const row = await findReplayJobById(handle.db, input.replay_job_id);
      if (row === null) return null;
      return {
        status: row.status,
        events_planned: row.events_planned,
        events_replayed: row.events_replayed,
        events_failed: row.events_failed,
      };
    },
    recordChunkProgress: async (input) => {
      const row = await recordReplayChunkProgress(handle.db, {
        replay_job_id: input.replay_job_id,
        cumulative_emitted: input.cumulative_emitted,
        cumulative_failed: input.cumulative_failed,
        now: input.now,
      });
      if (row === null) {
        // Row vanished between chunks; surface a terminal-looking status
        // so the executor's abort-mid-flight path engages.
        return {
          status: "cancelled",
          events_planned: 0,
          events_replayed: input.cumulative_emitted,
          events_failed: input.cumulative_failed,
        };
      }
      return {
        status: row.status,
        events_planned: row.events_planned,
        events_replayed: row.events_replayed,
        events_failed: row.events_failed,
      };
    },
    markCompleted: async (input) =>
      completeReplayJob(handle.db, {
        replay_job_id: input.replay_job_id,
        events_replayed: input.events_replayed,
        events_failed: input.events_failed,
        finished_at: input.now,
      }),
    markFailed: async (input) =>
      failReplayJob(handle.db, {
        replay_job_id: input.replay_job_id,
        events_replayed: input.events_replayed,
        events_failed: input.events_failed,
        finished_at: input.now,
        error_class: input.error_class,
        error_message: input.error_message,
      }),
    close: () => handle.close(),
  };
}

/**
 * Default transport I/O for the CLI replay-execute path. Wires the
 * source/producer adapters in `./stream-adapters` to a real RabbitMQ
 * connection: a channel per partition read (via the range-reader driver)
 * and a `PolarisProducer` for republishing.
 *
 * The Kafka version of this function also built an `Admin` client to
 * translate each chunk's time window into per-partition offsets. Streams
 * attach by timestamp, so that client — and the whole class of
 * off-by-one bugs around it — is gone.
 *
 * Replay reads write no checkpoint and join no group, so they cannot
 * disturb a live consumer's position no matter how many run at once.
 *
 * The returned `close()` tears everything down idempotently. The runner
 * calls it in its `finally` block.
 */
function buildDefaultTransportIo(): {
  readonly source: ReplayExecutorSource;
  readonly producer: ReplayExecutorProducer;
  readonly close: () => Promise<void>;
} {
  const config = loadConfigWithDefaults({
    serviceName: "polaris-cli",
    schema: rabbitmqEnvSchema,
  });
  const connection = createTransportConnection({ rabbitmq: config });
  const polarisProducer: PolarisProducer = createPolarisProducer({
    connection,
    producerName: "polaris-cli.replay-execute",
  });

  let producerConnected = false;
  async function ensureProducerConnected(): Promise<void> {
    if (producerConnected) return;
    await polarisProducer.connect();
    producerConnected = true;
  }

  const source = buildStreamReplaySource({
    // v1 always reads from raw.events; the planner asserts this in
    // `plan.source_topic_family` so callers see the same name here.
    family: STREAM_FAMILY_RAW_EVENTS,
    partitions: partitionsForFamily(config, STREAM_FAMILY_RAW_EVENTS),
    driverFactory: () => createAmqpStreamRangeDriver(connection),
  });

  const producer = buildStreamReplayProducer({
    producer: {
      ...polarisProducer,
      // Connect on first use so the runner does not have to know about
      // the producer's lifecycle.
      publish: async (input) => {
        await ensureProducerConnected();
        return polarisProducer.publish(input);
      },
    },
  });

  async function close(): Promise<void> {
    if (producerConnected) {
      try {
        await polarisProducer.disconnect();
      } catch {
        // Disconnecting a half-open producer throws; shutdown is
        // best-effort.
      }
      producerConnected = false;
    }
    await connection.close();
  }

  return { source, producer, close };
}

function buildLoggerAdapter(ctx: CommandContext): ReplayExecutorLogger {
  return {
    debug: (payload, message) => ctx.logger.debug(payload, message),
    info: (payload, message) => ctx.logger.info(payload, message),
    warn: (payload, message) => ctx.logger.warn(payload, message),
    error: (payload, message) => ctx.logger.error(payload, message),
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Project a `replay_jobs` row onto the planner's declaration shape.
 * Mirrors `plan.ts`'s adapter — the executor consumes a plan derived
 * from the same row the dry-run renderer reads.
 *
 * P7-001's row schema does not persist `processor_name`,
 * `processor_version`, `destinations_enabled`, or
 * `destination_opt_in_note`; the planner emits the
 * `processor_target_not_pinned` risk for processor-target rows that
 * lack the pin, and the executor refuses to ship them with the
 * matching `processor_target_not_pinned` refusal code. Future
 * persistence of those slots can land without changing this signature.
 */
function rowToDeclaration(row: ReplayJobRow): ReplayJobDeclaration {
  return {
    replay_job_id: row.replay_job_id,
    project_id: row.project_id,
    environment: row.environment,
    target: row.target,
    mode: row.mode,
    window_from: row.window_from,
    window_to: row.window_to,
    event_name: row.event_name,
    event_id: row.event_id,
    processor_name: undefined,
    processor_version: undefined,
    destinations_enabled: undefined,
    destination_opt_in_note: undefined,
  };
}

function emit(ctx: CommandContext, outcome: ExecuteReplayOutcome): void {
  const format = ctx.config.output;
  if (format === "json") {
    ctx.output.writeOut(renderJson(outcome));
    return;
  }
  ctx.output.writeOut(
    renderAccordingTo(format, {
      human: renderHuman(outcome),
      json: outcome,
    }),
  );
}

function renderHuman(outcome: ExecuteReplayOutcome): string {
  const lines: string[] = [
    `polaris replay execute outcome`,
    `  replay_job_id    ${outcome.replay_job_id}`,
    `  status           ${outcome.status}`,
    `  events_replayed  ${outcome.events_replayed}`,
    `  events_failed    ${outcome.events_failed}`,
    `  chunks_processed ${outcome.chunks.length}`,
    `  started_at       ${outcome.started_at}`,
    `  finished_at      ${outcome.finished_at}`,
  ];
  if (outcome.error !== null) {
    lines.push(`  error_class      ${outcome.error.error_class}`);
    lines.push(`  error_message    ${outcome.error.error_message}`);
  }
  return lines.join("\n");
}
