/**
 * `polaris processors dlq retry <dlq_id> [--dry-run]` — mutating.
 *
 * Republishes a processor DLQ row's byte-identical payload back to
 * its original source topic, then marks the row resolved. The
 * operator-readable receipt names both the source coordinates and
 * the destination of the retry. Same idempotency contract as
 * mark-resolved: re-running on a resolved row prints
 * `already-resolved` and exits cleanly.
 *
 * `mutates: true`: routes through the P6-007 production gate.
 */

import { loadConfigWithDefaults, rabbitmqEnvSchema } from "@polaris/shared-config";
import {
  createKafkaClient,
  createPolarisProducer,
  type PolarisProducer,
} from "@polaris/shared-transport";
import {
  createKyselyProcessorDlqRecordRepository,
  type MarkResolvedOutcome,
  type ProcessorDlqRecord,
} from "@polaris/shared-processor";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../../command.js";
import { connectDb } from "../../../db/index.js";
import { UsageError } from "../../../errors.js";
import { renderAccordingTo } from "../../../output.js";

interface RetryArgs {
  readonly dlqId: string;
  readonly note?: string;
  readonly dryRun?: boolean;
}

export interface ProcessorDlqRetryStore {
  findById(dlq_id: string): Promise<ProcessorDlqRecord | null>;
  markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
  ): Promise<MarkResolvedOutcome>;
  close(): Promise<void>;
}

export interface ProcessorDlqRetryProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: {
    topic: string;
    messages: Array<{
      value: Buffer | null;
      headers?: Record<string, string>;
    }>;
  }): Promise<unknown>;
}

export interface ProcessorDlqRetryHooks {
  readonly openStore?: () => ProcessorDlqRetryStore;
  readonly openProducer?: () => Promise<ProcessorDlqRetryProducer>;
}

export const processorsDlqRetryCommand: CommandDefinition = {
  id: "processors.dlq.retry",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("retry <dlq_id>")
      .description(
        "Republish a processor DLQ row's payload back to its source topic and mark the row resolved.",
      )
      .option("--note <text>", "Operator-supplied resolution note (<=1024 chars).")
      .option(
        "--dry-run",
        "Plan only: look up the row, validate the retry, but do NOT publish or mark resolved.",
      )
      .action(
        async (dlqId: string, opts: { note?: string; dryRun?: boolean }, command: Command) => {
          const wrapped = deps.runCommand<RetryArgs>(
            { id: "processors.dlq.retry", mutates: true },
            runProcessorsDlqRetry,
          );
          const args: RetryArgs = {
            dlqId,
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            ...(opts.dryRun === true ? { dryRun: true } : {}),
          };
          await wrapped(args, command);
        },
      );
  },
};

export function buildProcessorsDlqRetryRunner(hooks: ProcessorDlqRetryHooks = {}) {
  return async function runner(args: RetryArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const openProducer = hooks.openProducer ?? (() => defaultProducer(ctx.env));
    const id = args.dlqId.trim();
    if (id.length === 0) throw new UsageError("dlq_id is required");

    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) throw new UsageError(`dlq record "${id}" not found`);
      if (row.resolved_at !== null) {
        emit(ctx, { applied: false, action: "already_resolved", row });
        return undefined;
      }
      if (row.payload === null || row.payload.byteLength === 0) {
        throw new UsageError(
          `dlq record "${id}" has no payload bytes — cannot retry; use mark-resolved instead.`,
        );
      }

      if (args.dryRun === true) {
        emit(ctx, { applied: false, action: "dry_run", row });
        return undefined;
      }

      const producer = await openProducer();
      try {
        await producer.send({
          topic: row.source_topic,
          messages: [
            {
              value: row.payload,
              headers: { ...row.headers, "polaris-dlq-retry": id },
            },
          ],
        });
      } finally {
        try {
          await producer.disconnect();
        } catch {
          // best-effort
        }
      }

      const outcome = await store.markResolved(
        id,
        ctx.actor.label,
        (args.note ?? null) === null ? null : (args.note as string).trim(),
      );
      emit(ctx, {
        applied: outcome.applied,
        action: outcome.applied ? "retried" : "already_resolved",
        row: outcome.record,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsDlqRetry = buildProcessorsDlqRetryRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProcessorDlqRetryStore {
  const handle = connectDb({ env });
  const repo = createKyselyProcessorDlqRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    markResolved: (id, by, note) => repo.markResolved(id, by, note),
    close: () => handle.close(),
  };
}

async function defaultProducer(env: NodeJS.ProcessEnv): Promise<ProcessorDlqRetryProducer> {
  const config = loadConfigWithDefaults({
    serviceName: "polaris-cli",
    schema: rabbitmqEnvSchema,
    processEnv: env,
  });
  const kafka = createKafkaClient({ redpanda: config });
  const producer: PolarisProducer = createPolarisProducer({
    kafka,
    producerName: "polaris-cli.processors-dlq-retry",
  });
  await producer.connect();
  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    send: (record) =>
      producer.send({
        topic: record.topic,
        messages: record.messages.map((m) => ({
          value: m.value,
          ...(m.headers !== undefined ? { headers: m.headers } : {}),
        })),
      }),
  };
}

interface EmitInput {
  readonly applied: boolean;
  readonly action: "retried" | "already_resolved" | "dry_run";
  readonly row: ProcessorDlqRecord;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  const human =
    input.action === "retried"
      ? `retried ${input.row.dlq_id} → republished to ${input.row.source_topic} and marked resolved.\n`
      : input.action === "dry_run"
        ? `[dry-run] would republish ${input.row.dlq_id} → ${input.row.source_topic}.\n`
        : `${input.row.dlq_id} was already resolved (no-op).\n`;
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human,
      json: {
        applied: input.applied,
        action: input.action,
        dlq_id: input.row.dlq_id,
        source_topic: input.row.source_topic,
        source_partition: input.row.source_partition,
        source_offset: input.row.source_offset,
        resolved_at: input.row.resolved_at?.toISOString() ?? null,
        resolved_by: input.row.resolved_by,
        resolution_note: input.row.resolution_note,
      },
    }),
  );
}
