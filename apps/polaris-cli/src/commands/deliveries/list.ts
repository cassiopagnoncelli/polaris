/**
 * `polaris deliveries list <destination_id>` — read-only.
 *
 * Lists delivery records for one destination, newest first. Filter knobs:
 *
 *   --status <status>          accepted | delivered | dropped_consent |
 *                              dropped_no_identity | dropped_invalid |
 *                              mapped_failed | failed_retryable |
 *                              failed_permanent
 *   --error-class <class>      consent | identity | mapping | auth |
 *                              rate_limit | transient | permanent |
 *                              timeout | policy
 *   --since <iso-timestamp>    half-open finished_at lower bound
 *   --until <iso-timestamp>    half-open finished_at upper bound
 *   --limit <n>                max rows (default + hard cap = 1000)
 *
 * Each row prints the operationally-relevant subset:
 *
 *   delivery_id, event_id, event, attempt, status, error_class,
 *   vendor_response_code, finished_at, mapper_version, deliverer_version
 *
 * Secrets are absent by schema design. No filtering needed at the CLI
 * layer.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import {
  type DeliveryRecord,
  type DeliveryRecordErrorClass,
  type DeliveryRecordStatus,
  type ListDeliveryRecordsFilter,
  DELIVERY_RECORD_ERROR_CLASSES,
  DELIVERY_RECORD_STATUSES,
  createKyselyDeliveryRecordRepository,
  isDeliveryRecordErrorClass,
  isDeliveryRecordStatus,
} from "@polaris/shared-destinations";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface DeliveriesListArgs {
  readonly destinationId: string;
  readonly status?: string;
  readonly errorClass?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: string;
}

export interface DeliveriesListStore {
  list(
    destination_id: string,
    filter: ListDeliveryRecordsFilter,
  ): Promise<readonly DeliveryRecord[]>;
  close(): Promise<void>;
}

export interface DeliveriesListHooks {
  readonly openStore?: () => DeliveriesListStore;
}

export const deliveriesListCommand: CommandDefinition = {
  id: "deliveries.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list <destination_id>")
      .description(
        "List delivery records for a destination, newest first. Filter with --status, --error-class, --since, --until, --limit.",
      )
      .option("--status <status>", `Filter to one status: ${DELIVERY_RECORD_STATUSES.join(" | ")}.`)
      .option(
        "--error-class <error_class>",
        `Filter to one error_class: ${DELIVERY_RECORD_ERROR_CLASSES.join(" | ")}.`,
      )
      .option("--since <iso8601>", "Lower bound on finished_at (inclusive ISO-8601 UTC).")
      .option("--until <iso8601>", "Upper bound on finished_at (exclusive ISO-8601 UTC).")
      .option("--limit <n>", "Max rows to return (1..1000, default 1000).")
      .action(deps.runCommand({ id: "deliveries.list", mutates: false }, runDeliveriesList));
  },
};

export function buildDeliveriesListRunner(hooks: DeliveriesListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: DeliveriesListArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.destinationId.trim();
    if (id.length === 0) {
      throw new UsageError("destination_id is required");
    }

    const filter = parseFilter(args);

    const store = openStore();
    try {
      const rows = await store.list(id, filter);
      emit(ctx, id, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDeliveriesList = buildDeliveriesListRunner();

function parseFilter(args: DeliveriesListArgs): ListDeliveryRecordsFilter {
  const filter: {
    -readonly [K in keyof ListDeliveryRecordsFilter]: ListDeliveryRecordsFilter[K];
  } = {};
  if (args.status !== undefined) {
    const trimmed = args.status.trim();
    if (!isDeliveryRecordStatus(trimmed)) {
      throw new UsageError(
        `--status must be one of: ${DELIVERY_RECORD_STATUSES.join(", ")} (got "${trimmed}")`,
      );
    }
    filter.status = trimmed as DeliveryRecordStatus;
  }
  if (args.errorClass !== undefined) {
    const trimmed = args.errorClass.trim();
    if (!isDeliveryRecordErrorClass(trimmed)) {
      throw new UsageError(
        `--error-class must be one of: ${DELIVERY_RECORD_ERROR_CLASSES.join(
          ", ",
        )} (got "${trimmed}")`,
      );
    }
    filter.errorClass = trimmed as DeliveryRecordErrorClass;
  }
  if (args.since !== undefined) {
    filter.since = parseDate("--since", args.since);
  }
  if (args.until !== undefined) {
    filter.until = parseDate("--until", args.until);
  }
  if (args.limit !== undefined) {
    const parsed = Number.parseInt(args.limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--limit must be a positive integer (got "${args.limit}")`);
    }
    filter.limit = parsed;
  }
  return filter;
}

function parseDate(flag: string, raw: string): Date {
  const trimmed = raw.trim();
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new UsageError(`${flag} must be an ISO-8601 UTC timestamp (got "${trimmed}")`);
  }
  return new Date(ms);
}

function defaultStore(): DeliveriesListStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyDeliveryRecordRepository({ db: handle.db });
  return {
    list: (id, filter) => repo.findByDestinationId(id, filter),
    close: () => handle.close(),
  };
}

interface DeliveryView {
  readonly delivery_id: string;
  readonly event_id: string;
  readonly event: string;
  readonly attempt: number;
  readonly status: string;
  readonly error_class: string | null;
  readonly vendor_response_code: string | null;
  readonly finished_at: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
}

function toView(row: DeliveryRecord): DeliveryView {
  return {
    delivery_id: row.delivery_id,
    event_id: row.event_id,
    event: row.event_name,
    attempt: row.attempt,
    status: row.status,
    error_class: row.error_class,
    vendor_response_code: row.vendor_response_code,
    finished_at: row.finished_at.toISOString(),
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
  };
}

function emit(ctx: CommandContext, destination_id: string, rows: readonly DeliveryRecord[]): void {
  const views = rows.map(toView);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(destination_id, views),
      json: { destination_id, count: views.length, deliveries: views },
    }),
  );
}

function renderHuman(destination_id: string, views: readonly DeliveryView[]): string {
  if (views.length === 0) {
    return `no deliveries for ${destination_id}`;
  }
  const lines = [`destination_id  ${destination_id}`, `count           ${views.length}`, ""];
  for (const view of views) {
    lines.push(
      `${view.finished_at}  ${view.status.padEnd(18)}  ${view.delivery_id}  ` +
        `attempt=${view.attempt}  event=${view.event}  ` +
        `error_class=${view.error_class ?? "-"}  ` +
        `vendor_code=${view.vendor_response_code ?? "-"}  ` +
        `mapper=${view.mapper_version}  deliverer=${view.deliverer_version}`,
    );
  }
  return lines.join("\n");
}
