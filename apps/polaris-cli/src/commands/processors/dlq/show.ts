/**
 * `polaris processors dlq show <dlq_id>` — read-only.
 *
 * Renders one processor DLQ record's full triage view. The
 * `payload` column is the byte-identical original Kafka message
 * value (the canonical Polaris envelope JSON). The human renderer
 * surfaces it as a truncated UTF-8 preview; `--output json` carries
 * the full bytes as a base64 string.
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import {
  createKyselyProcessorDlqRecordRepository,
  type ProcessorDlqRecord,
} from "@polaris/pipeline";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../../command.js";
import { connectDb } from "../../../db/index.js";
import { UsageError } from "../../../errors.js";
import { renderAccordingTo } from "../../../output.js";

interface ShowArgs {
  readonly dlqId: string;
}

export interface ProcessorDlqShowStore {
  findById(dlq_id: string): Promise<ProcessorDlqRecord | null>;
  close(): Promise<void>;
}

export interface ProcessorDlqShowHooks {
  readonly openStore?: () => ProcessorDlqShowStore;
}

const PAYLOAD_PREVIEW_MAX = 400;

export const processorsDlqShowCommand: CommandDefinition = {
  id: "processors.dlq.show",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("show <dlq_id>")
      .description("Show one processor DLQ record's full triage view (headers + payload preview).")
      .action(async (dlqId: string, _opts: unknown, command: Command) => {
        const wrapped = deps.runCommand<ShowArgs>(
          { id: "processors.dlq.show", mutates: false },
          runProcessorsDlqShow,
        );
        await wrapped({ dlqId }, command);
      });
  },
};

export function buildProcessorsDlqShowRunner(hooks: ProcessorDlqShowHooks = {}) {
  return async function runner(args: ShowArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const id = args.dlqId.trim();
    if (id.length === 0) throw new UsageError("dlq_id is required");
    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) throw new UsageError(`dlq record "${id}" not found`);
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsDlqShow = buildProcessorsDlqShowRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProcessorDlqShowStore {
  const handle = connectDb({ env });
  const repo = createKyselyProcessorDlqRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: ProcessorDlqRecord): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: humanView(row),
      json: {
        dlq_id: row.dlq_id,
        published_at: row.published_at.toISOString(),
        processor_name: row.processor_name,
        processor_version: row.processor_version,
        event_id: row.event_id,
        event_name: row.event_name,
        project_id: row.project_id,
        environment: row.environment,
        attempts: row.attempts,
        reason: row.reason,
        error_class: row.error_class,
        error_message: row.error_message,
        source_topic: row.source_topic,
        source_partition: row.source_partition,
        source_offset: row.source_offset,
        headers: row.headers,
        payload_b64: row.payload !== null ? row.payload.toString("base64") : null,
        resolved_at: row.resolved_at?.toISOString() ?? null,
        resolved_by: row.resolved_by,
        resolution_note: row.resolution_note,
      },
    }),
  );
}

function humanView(row: ProcessorDlqRecord): string {
  const preview =
    row.payload !== null
      ? truncate(row.payload.toString("utf8"), PAYLOAD_PREVIEW_MAX)
      : "(no payload)";
  return [
    `dlq_id              ${row.dlq_id}`,
    `processor           ${row.processor_name} ${row.processor_version}`,
    `event_id            ${row.event_id}`,
    `event_name          ${row.event_name}`,
    `project_id          ${row.project_id}`,
    `environment         ${row.environment}`,
    `attempts            ${row.attempts}`,
    `reason              ${row.reason}`,
    `error_class         ${row.error_class ?? "-"}`,
    `error_message       ${row.error_message ?? "-"}`,
    `source_topic        ${row.source_topic}`,
    `source_partition    ${row.source_partition}`,
    `source_offset       ${row.source_offset}`,
    `published_at        ${row.published_at.toISOString()}`,
    `resolved_at         ${row.resolved_at?.toISOString() ?? "-"}`,
    `resolved_by         ${row.resolved_by ?? "-"}`,
    `resolution_note     ${row.resolution_note ?? "-"}`,
    "",
    "payload_preview:",
    preview,
    "",
  ].join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
