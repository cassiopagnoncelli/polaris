/**
 * `polaris deliveries show <delivery_id>` — read-only.
 *
 * Renders one delivery record's full state. The schema carries no secret
 * value and no full vendor response body; the output is safe to share.
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";

import {
  type DeliveryRecord,
  createKyselyDeliveryRecordRepository,
} from "@polaris/shared-destinations";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface DeliveriesShowArgs {
  readonly deliveryId: string;
}

export interface DeliveriesShowStore {
  findById(delivery_id: string): Promise<DeliveryRecord | null>;
  close(): Promise<void>;
}

export interface DeliveriesShowHooks {
  readonly openStore?: () => DeliveriesShowStore;
}

export const deliveriesShowCommand: CommandDefinition = {
  id: "deliveries.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <delivery_id>")
      .description("Show one delivery record's full state.");
    cmd.action(async (deliveryId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<DeliveriesShowArgs>(
        { id: "deliveries.show", mutates: false },
        runDeliveriesShow,
      );
      await wrapped({ deliveryId }, command);
    });
  },
};

export function buildDeliveriesShowRunner(hooks: DeliveriesShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: DeliveriesShowArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.deliveryId.trim();
    if (id.length === 0) {
      throw new UsageError("delivery_id is required");
    }
    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`delivery "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDeliveriesShow = buildDeliveriesShowRunner();

function defaultStore(): DeliveriesShowStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyDeliveryRecordRepository({ db: handle.db });
  return {
    findById: (id) => repo.findRecord(id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: DeliveryRecord): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: { delivery: toJson(row) },
    }),
  );
}

function toJson(row: DeliveryRecord): Record<string, unknown> {
  return {
    delivery_id: row.delivery_id,
    destination_id: row.destination_id,
    event_id: row.event_id,
    event: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    consumer_version: row.consumer_version,
    normalize_version: row.normalize_version,
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
    attempt: row.attempt,
    status: row.status,
    error_class: row.error_class,
    vendor_response_code: row.vendor_response_code,
    vendor_response_summary: row.vendor_response_summary,
    dedupe_key: row.dedupe_key,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at.toISOString(),
  };
}

function renderHuman(row: DeliveryRecord): string {
  const lines = [
    `delivery_id            ${row.delivery_id}`,
    `destination_id         ${row.destination_id}`,
    `event_id               ${row.event_id}`,
    `event                  ${row.event_name}`,
    `project_id             ${row.project_id}`,
    `environment            ${row.environment}`,
    `attempt                ${row.attempt}`,
    `status                 ${row.status}`,
    `error_class            ${row.error_class ?? "-"}`,
    `vendor_response_code   ${row.vendor_response_code ?? "-"}`,
    `vendor_response_summary ${row.vendor_response_summary ?? "-"}`,
    `dedupe_key             ${row.dedupe_key ?? "-"}`,
    `consumer_version       ${row.consumer_version}`,
    `normalize_version      ${row.normalize_version}`,
    `mapper_version         ${row.mapper_version}`,
    `deliverer_version      ${row.deliverer_version}`,
    `started_at             ${row.started_at.toISOString()}`,
    `finished_at            ${row.finished_at.toISOString()}`,
  ];
  return lines.join("\n");
}
