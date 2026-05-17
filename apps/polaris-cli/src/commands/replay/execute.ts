/**
 * `polaris replay execute <replay_job_id> [--target-topic <name>]
 *   [--dry-run-emit]` — mutating.
 *
 * Picks up a replay-job row, derives its plan via `@polaris/shared-replay`,
 * and runs the executor against an injected source/producer/store. The
 * default executor is wired against a stub source (P7-003 ships the
 * lifecycle scaffolding; the real Kafka source-side adapter lands once
 * `@polaris/shared-kafka` exposes the offset-range read helper). Tests
 * inject in-memory adapters so the lifecycle assertions land in this
 * task.
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

import { randomUUID } from "node:crypto";
import { loadConfigWithDefaults, redpandaEnvSchema } from "@polaris/shared-config";
import {
  createKafkaClient,
  createKafkaJsConsumerDriver,
  createPolarisProducer,
  type PolarisProducer,
  TOPIC_FAMILY_RAW_EVENTS,
} from "@polaris/shared-kafka";
import {
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
} from "@polaris/shared-replay";
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  completeReplayJob,
  connectDb,
  failReplayJob,
  findReplayJobById,
  markReplayJobRunning,
  type ReplayJobRow,
  recordReplayChunkProgress,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";
import {
  buildKafkaReplayProducer,
  buildKafkaReplaySource,
  type FetchOffsetsForWindow,
} from "./kafka-adapters.js";
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
  close(): Promise<void>;
}

/**
 * Hooks the runner accepts so tests bypass the default Kafka / DB
 * wiring. Production omits everything except `now`, which the
 * dispatcher's clock hook supplies.
 */
export interface ReplayExecuteHooks {
  readonly openStore?: () => ReplayExecuteStore;
  readonly source?: () => ReplayExecutorSource;
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
  // The kafka I/O default is lazy: tests that inject both `hooks.source`
  // and `hooks.producer` never trigger a real Redpanda connection.
  const buildDefaultIo =
    hooks.source === undefined || hooks.producer === undefined ? buildDefaultKafkaIo : null;

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
    const kafkaIo = buildDefaultIo ? buildDefaultIo() : null;
    const sourceFactory =
      hooks.source ??
      (() => {
        if (kafkaIo === null) {
          throw new Error("replay execute runner: kafka I/O unavailable");
        }
        return kafkaIo.source;
      });
    const producerFactory =
      hooks.producer ??
      (() => {
        if (kafkaIo === null) {
          throw new Error("replay execute runner: kafka I/O unavailable");
        }
        return kafkaIo.producer;
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
      let derived: ReplayPlan;
      try {
        derived = planReplay(declaration, { now: nowFn() });
      } catch (err) {
        if (err instanceof ReplayPlanError) {
          throw new UsageError(`replay_plan_rejected:${err.code}: ${err.message}`, {
            code: err.code,
            replay_job_id: id,
          });
        }
        throw err;
      }

      const source = sourceFactory();
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
      if (kafkaIo) {
        await kafkaIo.close();
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
  return {
    findById: (id) => findReplayJobById(handle.db, id),
    markRunning: async (input) => {
      const row = await markReplayJobRunning(handle.db, {
        replay_job_id: input.replay_job_id,
        events_planned: input.events_planned,
        started_at: input.now,
      });
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
 * Default kafka I/O resources for the CLI replay-execute path. Wires
 * the source/producer adapters in `./kafka-adapters` to a real
 * Redpanda connection: a dedicated `Consumer` (used per partition-read
 * via the offset-range driver), an `Admin` client (for the
 * time → offset lookup), and a `PolarisProducer` (for republishing).
 *
 * The returned `close()` disconnects everything, idempotently. The
 * runner is responsible for calling it in its `finally` block.
 */
function buildDefaultKafkaIo(): {
  readonly source: ReplayExecutorSource;
  readonly producer: ReplayExecutorProducer;
  readonly close: () => Promise<void>;
} {
  const config = loadConfigWithDefaults({
    serviceName: "polaris-cli",
    schema: redpandaEnvSchema,
  });
  const kafka = createKafkaClient({ redpanda: config });
  const admin = kafka.admin();
  const polarisProducer: PolarisProducer = createPolarisProducer({
    kafka,
    producerName: "polaris-cli.replay-execute",
  });

  let adminConnected = false;
  let producerConnected = false;

  async function ensureAdminConnected(): Promise<void> {
    if (adminConnected) return;
    await admin.connect();
    adminConnected = true;
  }

  async function ensureProducerConnected(): Promise<void> {
    if (producerConnected) return;
    await polarisProducer.connect();
    producerConnected = true;
  }

  // Time → offset translation via KafkaJS admin. KafkaJS's
  // `fetchTopicOffsetsByTimestamp` returns the FIRST offset at or
  // after each partition's timestamp; we use it twice (chunk.from and
  // chunk.to + 1ms) and bound the high side at `endOffset - 1` so the
  // offset-range reader's inclusive semantics line up with the chunk's
  // inclusive end.
  const fetchOffsetsForWindow: FetchOffsetsForWindow = async ({ topic, from, to }) => {
    await ensureAdminConnected();
    const startRows = await admin.fetchTopicOffsetsByTimestamp(topic, from);
    const endRows = await admin.fetchTopicOffsetsByTimestamp(topic, to + 1);
    const endByPartition = new Map<number, string>();
    for (const row of endRows) {
      endByPartition.set(row.partition, row.offset);
    }
    const ranges: Array<{ partition: number; startOffset: string; endOffset: string }> = [];
    for (const row of startRows) {
      const endExclusive = endByPartition.get(row.partition);
      if (endExclusive === undefined) continue;
      const endInclusive = (BigInt(endExclusive) - 1n).toString();
      // Empty windows (start > end) are filtered downstream by the
      // adapter; emit them so the caller has a stable per-partition row.
      ranges.push({
        partition: row.partition,
        startOffset: row.offset,
        endOffset: endInclusive,
      });
    }
    return ranges;
  };

  // The source builds a fresh consumer + driver per chunk so the
  // offset-range reader's `release()` (which calls `consumer.stop()` +
  // `consumer.disconnect()`) does not tear down a long-lived consumer.
  // The trade-off is a connection per partition-read; replay throughput
  // is bounded by the broker anyway and the alternative (a single
  // consumer fanning out across rebalances) is fragile against
  // partition reassignment mid-read.
  const source = buildKafkaReplaySource({
    // v1 always reads from raw.events; the planner asserts this in
    // `plan.source_topic_family` so callers see the same name here.
    topic: TOPIC_FAMILY_RAW_EVENTS,
    driverFactory: () => {
      const consumer = kafka.consumer({
        // Replay reads do not participate in any consumer group's
        // offset bookkeeping; use a per-call group id so KafkaJS does
        // not reuse a group's committed offsets across replays.
        groupId: `polaris-cli.replay.${randomUUID()}`,
        // Disable auto-commit; the offset-range reader seeks manually.
        readUncommitted: false,
      });
      return createKafkaJsConsumerDriver({ consumer });
    },
    fetchOffsetsForWindow,
  });

  const producer = buildKafkaReplayProducer({
    producer: {
      ...polarisProducer,
      // Wrap `send` so the producer connects on first use without
      // forcing the runner to know about kafkajs's lifecycle.
      send: async (record) => {
        await ensureProducerConnected();
        return polarisProducer.send(record);
      },
    },
  });

  async function close(): Promise<void> {
    if (adminConnected) {
      try {
        await admin.disconnect();
      } catch {
        // KafkaJS throws when disconnect runs against a half-connected
        // client; the runner swallows it because shutdown is best-effort.
      }
      adminConnected = false;
    }
    if (producerConnected) {
      try {
        await polarisProducer.disconnect();
      } catch {
        // Same idempotency dance as admin.
      }
      producerConnected = false;
    }
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
