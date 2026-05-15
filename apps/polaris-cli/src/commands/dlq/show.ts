/**
 * `polaris dlq show <dlq_id>` — read-only.
 *
 * Renders one DLQ record's full triage view. The `payload` column carries
 * the Kafka message bytes — the canonical Polaris envelope JSON. This
 * command emits it as a UTF-8 string under `payload_preview` (truncated
 * to a label-safe length for human output, full bytes in `--output
 * json`). No secret material lives in the bytes; the canonical envelope
 * is the same shape ingester accepts.
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import { createKyselyDlqRecordRepository, type DlqRecord } from "@polaris/shared-destinations";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface DlqShowArgs {
  readonly dlqId: string;
}

export interface DlqShowStore {
  findById(dlq_id: string): Promise<DlqRecord | null>;
  close(): Promise<void>;
}

export interface DlqShowHooks {
  readonly openStore?: () => DlqShowStore;
}

/** Max chars rendered from `payload` in human output. */
const PAYLOAD_PREVIEW_MAX = 400;

export const dlqShowCommand: CommandDefinition = {
  id: "dlq.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <dlq_id>")
      .description("Show one DLQ record's full triage view (headers + payload preview).");
    cmd.action(async (dlqId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<DlqShowArgs>({ id: "dlq.show", mutates: false }, runDlqShow);
      await wrapped({ dlqId }, command);
    });
  },
};

export function buildDlqShowRunner(hooks: DlqShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: DlqShowArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.dlqId.trim();
    if (id.length === 0) {
      throw new UsageError("dlq_id is required");
    }
    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`dlq record "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDlqShow = buildDlqShowRunner();

function defaultStore(): DlqShowStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyDlqRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: DlqRecord): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: { dlq: toJson(row) },
    }),
  );
}

function payloadPreview(payload: Buffer | null): string {
  if (payload === null || payload.length === 0) return "<empty>";
  const text = payload.toString("utf8");
  if (text.length <= PAYLOAD_PREVIEW_MAX) return text;
  return `${text.slice(0, PAYLOAD_PREVIEW_MAX)}… (${text.length - PAYLOAD_PREVIEW_MAX} more chars)`;
}

function payloadAsString(payload: Buffer | null): string | null {
  return payload === null ? null : payload.toString("utf8");
}

function toJson(row: DlqRecord): Record<string, unknown> {
  return {
    dlq_id: row.dlq_id,
    destination_id: row.destination_id,
    event_id: row.event_id,
    event: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    consumer_version: row.consumer_version,
    normalize_version: row.normalize_version,
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
    attempts: row.attempts,
    reason: row.reason,
    error_class: row.error_class,
    vendor_response_code: row.vendor_response_code,
    vendor_response_summary: row.vendor_response_summary,
    delivery_key: row.delivery_key,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    headers: row.headers,
    payload: payloadAsString(row.payload),
    published_at: row.published_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  };
}

function renderHuman(row: DlqRecord): string {
  const lines = [
    `dlq_id                 ${row.dlq_id}`,
    `destination_id         ${row.destination_id}`,
    `event_id               ${row.event_id}`,
    `event                  ${row.event_name}`,
    `project_id             ${row.project_id}`,
    `environment            ${row.environment}`,
    `vendor                 ${row.vendor}`,
    `consumer_version       ${row.consumer_version}`,
    `normalize_version      ${row.normalize_version}`,
    `mapper_version         ${row.mapper_version}`,
    `deliverer_version      ${row.deliverer_version}`,
    `attempts               ${row.attempts}`,
    `reason                 ${row.reason}`,
    `error_class            ${row.error_class ?? "-"}`,
    `vendor_response_code   ${row.vendor_response_code ?? "-"}`,
    `vendor_response_summary ${row.vendor_response_summary ?? "-"}`,
    `delivery_key           ${row.delivery_key ?? "-"}`,
    `source_topic           ${row.source_topic}`,
    `source_partition       ${row.source_partition}`,
    `source_offset          ${row.source_offset}`,
    `published_at           ${row.published_at.toISOString()}`,
    `resolved_at            ${row.resolved_at === null ? "-" : row.resolved_at.toISOString()}`,
    `resolved_by            ${row.resolved_by ?? "-"}`,
    `resolution_note        ${row.resolution_note ?? "-"}`,
    "",
    "headers:",
  ];
  for (const [k, v] of Object.entries(row.headers).sort()) {
    lines.push(`  ${k}=${v}`);
  }
  lines.push("", `payload_preview:`, payloadPreview(row.payload));
  return lines.join("\n");
}
