/**
 * `polaris dlq retry <dlq_id> [--note "<text>"]` — mutating.
 *
 * Republishes the DLQ record's original Kafka bytes to the same topic
 * the destination runtime consumes (`source_topic` on the row), then
 * marks the DLQ row resolved (`resolved_by` = CLI actor, optional
 * `resolution_note`). The destination runtime's dedupe layer protects
 * against double-delivery: each row carries the original `delivery_key`,
 * and the runtime short-circuits a repeat delivery for the same
 * (destination_id, delivery_key) pair.
 *
 * Failure semantics:
 *
 *   - DLQ row missing → exit 2 (usage error).
 *   - Row already resolved → exit 0; reports "already resolved".
 *   - Producer connect / send fails → exit 1; row stays unresolved so
 *     the operator can retry.
 *   - Mark-resolved + audit write happens AFTER the Kafka publish
 *     succeeds; on transient PG failure the row is published but not
 *     marked, and a follow-up `mark-resolved` clears it.
 *
 * Audit trail: writes a `dlq.retry` row to `audit_records` in the same
 * Kysely transaction as the row update. Snapshots include the row state
 * pre- and post-update; the bytes payload is not echoed into the audit
 * row.
 *
 * Kafka producer wiring: built from `POLARIS_RABBITMQ_*` env vars on
 * demand and disconnected after the single publish. The CLI does not
 * keep a long-lived broker connection.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */

import { loadConfigWithDefaults, rabbitmqEnvSchema } from "@polaris/runtime-config";
import {
  createKyselyDlqRecordRepository,
  type DlqRecord,
  type DlqRecordRepository,
} from "@polaris/delivery-destinations";
import {
  createPolarisProducer,
  createTransportConnection,
  type PolarisProducer,
  redeliverQueueName,
} from "@polaris/bus";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  markDlqResolvedWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { toAuditSnapshot } from "./snapshot.js";

interface DlqRetryArgs {
  readonly dlqId: string;
  readonly note?: string;
}

export interface DlqRetryAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: ReturnType<typeof toAuditSnapshot>;
  readonly after: ReturnType<typeof toAuditSnapshot>;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly note: string | null;
  readonly republishedTopic: string;
}

/**
 * Producer shape the retry runner needs. Narrower than `PolarisProducer`
 * so test stubs don't have to satisfy the full interface.
 */
export interface RetryProducer {
  /**
   * Republish one message onto a queue. The target is the failing
   * component's redelivery queue, never the source stream — see the note
   * at the call site.
   */
  publishToQueue(record: {
    queue: string;
    value: Buffer;
    headers?: Record<string, string>;
  }): Promise<unknown>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DlqRetryStore {
  findById(dlq_id: string): Promise<DlqRecord | null>;
  markResolvedWithAudit(
    dlq_id: string,
    actorLabel: string,
    note: string | null,
    now: Date,
    audit: DlqRetryAuditPayload,
  ): Promise<DlqRecord>;
  close(): Promise<void>;
}

export interface DlqRetryHooks {
  readonly openStore?: () => DlqRetryStore;
  readonly openProducer?: () => Promise<RetryProducer>;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const dlqRetryCommand: CommandDefinition = {
  id: "dlq.retry",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("retry <dlq_id>")
      .description(
        "Republish a DLQ record to its source topic and mark resolved. Runtime dedupe protects against double-delivery.",
      )
      .option(
        "--note <text>",
        "Optional operator-supplied retry note (max 1024 chars); recorded on the resolution and the audit row.",
      );
    cmd.action(async (dlqId: string, opts: { note?: string }, command: Command) => {
      const wrapped = deps.runCommand<DlqRetryArgs>(
        { id: "dlq.retry", mutates: true },
        runDlqRetry,
      );
      const args: DlqRetryArgs = {
        dlqId,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildDlqRetryRunner(hooks: DlqRetryHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: DlqRetryArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const openProducer = hooks.openProducer ?? (() => defaultProducer(ctx.env));
    const id = args.dlqId.trim();
    if (id.length === 0) throw new UsageError("dlq_id is required");
    const note = args.note?.trim();
    if (note !== undefined && note.length > 1024) {
      throw new UsageError("--note must be 1024 characters or fewer");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`dlq record "${id}" not found`);
      }
      if (existing.resolved_at !== null) {
        emit(ctx, {
          dlqId: id,
          applied: false,
          republished: false,
          resolvedAt: existing.resolved_at,
          resolvedBy: existing.resolved_by,
          republishedTopic: null,
        });
        return undefined;
      }
      if (existing.payload === null) {
        throw new UsageError(
          `dlq record "${id}" has no stored payload bytes; cannot retry. Use mark-resolved instead.`,
        );
      }

      // 1. Republish. Failures here leave the DLQ row unresolved so the
      //    operator can retry.
      //
      //    The target is `<vendor>.redeliver`, NOT the source stream.
      //    Publishing back into `analytics.events` would re-deliver the
      //    event to every consumer of that family — the ClickHouse sink
      //    and four sibling destinations included — turning one
      //    operator's retry into platform-wide double-processing. The
      //    Kafka topology had no queue to aim at; this one does.
      const producer = await openProducer();
      try {
        await producer.connect();
        await producer.publishToQueue({
          queue: redeliverQueueName(existing.vendor),
          value: existing.payload,
          headers: { ...existing.headers },
        });
      } finally {
        try {
          await producer.disconnect();
        } catch {
          // Disconnect errors are non-fatal; the publish already landed.
        }
      }

      // 2. Mark resolved + write audit row in one PostgreSQL transaction.
      const now = nowFn();
      const auditId = generateAuditId();
      const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;
      const noteValue = note === undefined || note.length === 0 ? null : note;
      const audit: DlqRetryAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel,
        occurredAt: now,
        before: toAuditSnapshot(existing),
        after: toAuditSnapshot({
          ...existing,
          resolved_at: now,
          resolved_by: actorLabel,
          resolution_note: noteValue,
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        note: noteValue,
        republishedTopic: redeliverQueueName(existing.vendor),
      };

      const updated = await store.markResolvedWithAudit(id, actorLabel, noteValue, now, audit);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "dlq.retry",
          dlq_id: id,
          destination_id: existing.destination_id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          source_topic: existing.source_topic,
          resolved_by: actorLabel,
          occurred_at: now.toISOString(),
        },
        "dlq record republished and marked resolved (audit row persisted)",
      );

      emit(ctx, {
        dlqId: id,
        applied: true,
        republished: true,
        resolvedAt: updated.resolved_at,
        resolvedBy: updated.resolved_by,
        republishedTopic: redeliverQueueName(existing.vendor),
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDlqRetry = buildDlqRetryRunner();

function defaultStore(env: NodeJS.ProcessEnv): DlqRetryStore {
  const handle = connectDb({ env });
  const repo: DlqRecordRepository = createKyselyDlqRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    markResolvedWithAudit: async (id, actorLabel, note, now, audit) => {
      const existing = await repo.findRecord(id);
      if (existing === null) {
        throw new Error(`dlq_records: id "${id}" not found`);
      }
      const outcome = await markDlqResolvedWithAudit(
        handle.db,
        {
          dlqId: existing.dlq_id,
          projectId: existing.project_id,
          environment: existing.environment,
          owner: existing.vendor,
          reason: existing.reason,
        },
        { resolvedBy: actorLabel, note },
        {
          auditId: audit.auditId,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          occurredAt: now,
          before: audit.before,
          after: audit.after,
        },
      );
      // The store contract returns the row; `applied` is implicit in whether
      // resolved_at moved, which the caller reads off the record.
      void outcome;
      return (await repo.findRecord(id)) ?? existing;
    },
    close: () => handle.close(),
  };
}

async function defaultProducer(env: NodeJS.ProcessEnv): Promise<RetryProducer> {
  // Build a rabbitmq config block from env using the shared schema; no
  // other Polaris services in the CLI need the broker, so we keep this
  // local rather than hoist into shared connect-helpers.
  const config = loadConfigWithDefaults({
    serviceName: "polaris-cli",
    schema: rabbitmqEnvSchema,
    processEnv: env,
  });
  const connection = createTransportConnection({ rabbitmq: config });
  const producer: PolarisProducer = createPolarisProducer({
    connection,
    producerName: "polaris-cli.dlq-retry",
  });
  return {
    connect: () => producer.connect(),
    disconnect: async () => {
      await producer.disconnect();
      await connection.close();
    },
    publishToQueue: (record) =>
      producer.publishToQueue({
        queue: record.queue,
        value: record.value,
        ...(record.headers !== undefined ? { headers: record.headers } : {}),
      }),
  };
}

interface EmitInput {
  readonly dlqId: string;
  readonly applied: boolean;
  readonly republished: boolean;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly republishedTopic: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        dlq_id: input.dlqId,
        applied: input.applied,
        republished: input.republished,
        resolved_at: input.resolvedAt === null ? null : input.resolvedAt.toISOString(),
        resolved_by: input.resolvedBy,
        republished_topic: input.republishedTopic,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `retried ${input.dlqId}: republished to ${input.republishedTopic ?? "?"}, marked resolved by ${input.resolvedBy} at ${input.resolvedAt?.toISOString() ?? "-"}`;
  }
  return `${input.dlqId}: already resolved (by ${input.resolvedBy ?? "?"} at ${
    input.resolvedAt?.toISOString() ?? "?"
  })`;
}
