/**
 * `polaris processors dlq list --processor <name> [...]` — read-only.
 *
 * Lists processor DLQ records for a given processor, newest first.
 * Unlike the destination DLQ surface (which lets operators pivot
 * across vendors), processors triage by processor_name — each
 * processor owns its own DLQ topic and runbook.
 *
 *   --processor <name>      scope (required)
 *   --reason <reason>       narrow by free-form reason string
 *   --since <iso>           inclusive published_at lower bound
 *   --until <iso>           exclusive published_at upper bound
 *   --include-resolved      include rows already marked resolved
 *   --limit <n>             max rows (1..1000, default 1000)
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import {
  createKyselyProcessorDlqRecordRepository,
  type ListProcessorDlqRecordsFilter,
  type ProcessorDlqRecord,
} from "@polaris/shared-processor";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../../command.js";
import { connectDb } from "../../../db/index.js";
import { UsageError } from "../../../errors.js";
import { renderAccordingTo } from "../../../output.js";

interface ListArgs {
  readonly processor?: string;
  readonly reason?: string;
  readonly since?: string;
  readonly until?: string;
  readonly includeResolved?: boolean;
  readonly limit?: string;
}

export interface ProcessorDlqListStore {
  listByProcessor(
    processor_name: string,
    filter: ListProcessorDlqRecordsFilter,
  ): Promise<readonly ProcessorDlqRecord[]>;
  close(): Promise<void>;
}

export interface ProcessorDlqListHooks {
  readonly openStore?: () => ProcessorDlqListStore;
}

export const processorsDlqListCommand: CommandDefinition = {
  id: "processors.dlq.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List processor DLQ records for one processor, newest first.")
      .requiredOption("--processor <name>", "Scope to one processor (required).")
      .option("--reason <reason>", "Filter to one free-form reason string.")
      .option("--since <iso8601>", "Lower bound on published_at (inclusive ISO-8601 UTC).")
      .option("--until <iso8601>", "Upper bound on published_at (exclusive ISO-8601 UTC).")
      .option("--include-resolved", "Include rows already marked resolved.")
      .option("--limit <n>", "Max rows (1..1000, default 1000).")
      .action(async (opts: ListArgs, command: Command) => {
        const wrapped = deps.runCommand<ListArgs>(
          { id: "processors.dlq.list", mutates: false },
          runProcessorsDlqList,
        );
        await wrapped(opts, command);
      });
  },
};

export function buildProcessorsDlqListRunner(hooks: ProcessorDlqListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  return async function runner(args: ListArgs, ctx: CommandContext): Promise<undefined> {
    const processor = (args.processor ?? "").trim();
    if (processor.length === 0) {
      throw new UsageError("--processor is required");
    }
    const filter: ListProcessorDlqRecordsFilter = {};
    if (args.reason !== undefined) (filter as { reason?: string }).reason = args.reason;
    if (args.since !== undefined)
      (filter as { since?: Date }).since = parseIsoOrThrow(args.since, "--since");
    if (args.until !== undefined)
      (filter as { until?: Date }).until = parseIsoOrThrow(args.until, "--until");
    if (args.includeResolved !== undefined) {
      (filter as { includeResolved?: boolean }).includeResolved = args.includeResolved;
    }
    if (args.limit !== undefined) {
      const n = Number.parseInt(args.limit, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new UsageError("--limit must be a positive integer");
      }
      (filter as { limit?: number }).limit = n;
    }

    const store = openStore();
    try {
      const rows = await store.listByProcessor(processor, filter);
      emit(ctx, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsDlqList = buildProcessorsDlqListRunner();

function defaultStore(): ProcessorDlqListStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyProcessorDlqRecordRepository({ db: handle.db });
  return {
    listByProcessor: (name, filter) => repo.findByProcessor(name, filter),
    close: () => handle.close(),
  };
}

function parseIsoOrThrow(raw: string, flag: string): Date {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    throw new UsageError(`${flag} must be an ISO-8601 timestamp; got "${raw}"`);
  }
  return new Date(ms);
}

function emit(ctx: CommandContext, rows: readonly ProcessorDlqRecord[]): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: humanTable(rows),
      json: rows.map((r) => ({
        dlq_id: r.dlq_id,
        published_at: r.published_at.toISOString(),
        processor_name: r.processor_name,
        processor_version: r.processor_version,
        event_id: r.event_id,
        event_name: r.event_name,
        project_id: r.project_id,
        environment: r.environment,
        attempts: r.attempts,
        reason: r.reason,
        error_class: r.error_class,
        error_message: r.error_message,
        source_topic: r.source_topic,
        source_partition: r.source_partition,
        source_offset: r.source_offset,
        resolved_at: r.resolved_at?.toISOString() ?? null,
        resolved_by: r.resolved_by,
        resolution_note: r.resolution_note,
      })),
    }),
  );
}

function humanTable(rows: readonly ProcessorDlqRecord[]): string {
  if (rows.length === 0) return "No DLQ rows.\n";
  const header =
    "PUBLISHED_AT          DLQ_ID                EVENT             ATTEMPTS REASON              RESOLVED";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        r.published_at.toISOString(),
        r.dlq_id.padEnd(20),
        r.event_name.padEnd(17),
        String(r.attempts).padStart(8),
        r.reason.padEnd(19),
        r.resolved_at !== null ? "yes" : "no",
      ].join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}
