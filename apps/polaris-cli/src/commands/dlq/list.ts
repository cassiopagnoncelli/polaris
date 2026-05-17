/**
 * `polaris dlq list [--destination <id>] [--vendor <name>] ...` — read-only.
 *
 * Lists DLQ records, newest first. Exactly one of `--destination` and
 * `--vendor` is required so the query always pivots through one of the
 * partial indexes.
 *
 *   --destination <destination_id>   scope to one destination
 *   --vendor <vendor>                scope to one vendor (across all dests)
 *   --error-class <class>            narrow by closed-set error_class label
 *   --reason <reason>                narrow by free-form reason string
 *   --since <iso>                    inclusive published_at lower bound
 *   --until <iso>                    exclusive published_at upper bound
 *   --include-resolved               include rows already marked resolved
 *   --limit <n>                      max rows (1..1000, default 1000)
 *
 * Output columns:
 *
 *   published_at, dlq_id, vendor, destination_id, event, attempts,
 *   reason, error_class, resolved_by
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import {
  createKyselyDlqRecordRepository,
  DELIVERY_RECORD_ERROR_CLASSES,
  type DeliveryRecordErrorClass,
  type DlqRecord,
  isDeliveryRecordErrorClass,
  type ListDlqRecordsFilter,
} from "@polaris/shared-destinations";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface DlqListArgs {
  readonly destination?: string;
  readonly vendor?: string;
  readonly errorClass?: string;
  readonly reason?: string;
  readonly since?: string;
  readonly until?: string;
  readonly includeResolved?: boolean;
  readonly limit?: string;
}

type ListScope =
  | { readonly kind: "destination"; readonly destination_id: string }
  | { readonly kind: "vendor"; readonly vendor: string };

export interface DlqListStore {
  list(scope: ListScope, filter: ListDlqRecordsFilter): Promise<readonly DlqRecord[]>;
  close(): Promise<void>;
}

export interface DlqListHooks {
  readonly openStore?: () => DlqListStore;
}

export const dlqListCommand: CommandDefinition = {
  id: "dlq.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List DLQ records for a destination or vendor, newest first. Exactly one of --destination or --vendor is required.",
      )
      .option("--destination <destination_id>", "Scope to one destination.")
      .option("--vendor <vendor>", "Scope to one vendor (across all destinations).")
      .option(
        "--error-class <error_class>",
        `Filter to one error_class: ${DELIVERY_RECORD_ERROR_CLASSES.join(" | ")}.`,
      )
      .option("--reason <reason>", "Filter to one free-form reason string.")
      .option("--since <iso8601>", "Lower bound on published_at (inclusive ISO-8601 UTC).")
      .option("--until <iso8601>", "Upper bound on published_at (exclusive ISO-8601 UTC).")
      .option(
        "--include-resolved",
        "Include rows that operators have already marked resolved (default: unresolved only).",
        false,
      )
      .option("--limit <n>", "Max rows to return (1..1000, default 1000).")
      .action(deps.runCommand({ id: "dlq.list", mutates: false }, runDlqList));
  },
};

export function buildDlqListRunner(hooks: DlqListHooks = {}) {
  return async function runner(args: DlqListArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const scope = pickScope(args);
    const filter = parseFilter(args);
    const store = openStore();
    try {
      const rows = await store.list(scope, filter);
      emit(ctx, scope, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDlqList = buildDlqListRunner();

function pickScope(args: DlqListArgs): ListScope {
  const destination = trim(args.destination);
  const vendor = trim(args.vendor);
  if (destination !== undefined && vendor !== undefined) {
    throw new UsageError("specify exactly one of --destination or --vendor, not both");
  }
  if (destination !== undefined) {
    return { kind: "destination", destination_id: destination };
  }
  if (vendor !== undefined) {
    return { kind: "vendor", vendor };
  }
  throw new UsageError("exactly one of --destination or --vendor is required");
}

function parseFilter(args: DlqListArgs): ListDlqRecordsFilter {
  const filter: {
    -readonly [K in keyof ListDlqRecordsFilter]: ListDlqRecordsFilter[K];
  } = {};
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
  if (args.reason !== undefined) {
    const reason = args.reason.trim();
    if (reason.length === 0) throw new UsageError("--reason cannot be empty");
    filter.reason = reason;
  }
  if (args.since !== undefined) filter.since = parseDate("--since", args.since);
  if (args.until !== undefined) filter.until = parseDate("--until", args.until);
  if (args.includeResolved === true) filter.includeResolved = true;
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

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function defaultStore(env: NodeJS.ProcessEnv): DlqListStore {
  const handle = connectDb({ env });
  const repo = createKyselyDlqRecordRepository({ db: handle.db });
  return {
    list: (scope, filter) =>
      scope.kind === "destination"
        ? repo.findByDestinationId(scope.destination_id, filter)
        : repo.findByVendor(scope.vendor, filter),
    close: () => handle.close(),
  };
}

interface DlqView {
  readonly dlq_id: string;
  readonly destination_id: string;
  readonly vendor: string;
  readonly event_id: string;
  readonly event: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class: string | null;
  readonly published_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly vendor_response_code: string | null;
}

function toView(row: DlqRecord): DlqView {
  return {
    dlq_id: row.dlq_id,
    destination_id: row.destination_id,
    vendor: row.vendor,
    event_id: row.event_id,
    event: row.event_name,
    attempts: row.attempts,
    reason: row.reason,
    error_class: row.error_class,
    published_at: row.published_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolved_by: row.resolved_by,
    vendor_response_code: row.vendor_response_code,
  };
}

function emit(ctx: CommandContext, scope: ListScope, rows: readonly DlqRecord[]): void {
  const views = rows.map(toView);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(scope, views),
      json: {
        scope:
          scope.kind === "destination"
            ? { destination_id: scope.destination_id }
            : { vendor: scope.vendor },
        count: views.length,
        dlq: views,
      },
    }),
  );
}

function renderHuman(scope: ListScope, views: readonly DlqView[]): string {
  const scopeLabel =
    scope.kind === "destination" ? `destination ${scope.destination_id}` : `vendor ${scope.vendor}`;
  if (views.length === 0) {
    return `no dlq entries for ${scopeLabel}`;
  }
  const lines = [`scope   ${scopeLabel}`, `count   ${views.length}`, ""];
  for (const view of views) {
    const resolved = view.resolved_by !== null ? ` resolved_by=${view.resolved_by}` : "";
    lines.push(
      `${view.published_at}  ${view.reason.padEnd(20)}  ${view.dlq_id}  ` +
        `attempts=${view.attempts}  event=${view.event}  ` +
        `vendor=${view.vendor}  destination=${view.destination_id}  ` +
        `error_class=${view.error_class ?? "-"}  ` +
        `vendor_code=${view.vendor_response_code ?? "-"}${resolved}`,
    );
  }
  return lines.join("\n");
}
