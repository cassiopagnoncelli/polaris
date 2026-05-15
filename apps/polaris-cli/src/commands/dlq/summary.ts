/**
 * `polaris dlq summary (--destination <id> | --vendor <name>) [--since ...] [--until ...] [--include-resolved]` — read-only.
 *
 * Aggregates DLQ rows for one destination or one vendor into a triage
 * snapshot the operator uses during the "inspect DLQ volume" step of the
 * triage runbook (P10-006). The summary is intentionally narrow:
 *
 *   - One of `--destination` or `--vendor` is required so the query
 *     pivots through one of the partial indexes on `dlq_records`. This
 *     mirrors `polaris dlq list` and avoids accidental cross-tenant
 *     scans.
 *   - Optional `--since` / `--until` bound the published_at window.
 *   - `--include-resolved` includes rows operators already marked
 *     resolved; default is unresolved-only (matches the active-triage
 *     workflow).
 *   - The aggregate caps at 1000 rows (`LIST_DLQ_RECORDS_HARD_LIMIT`).
 *     When the cap is hit the output marks `truncated: true` so the
 *     operator knows the count is a floor.
 *
 * The aggregation runs client-side over rows the existing repository
 * surface returns. No new business logic, no new SQL — the command is a
 * thin operator affordance on top of `findByDestinationId` /
 * `findByVendor`.
 *
 * Output columns (human):
 *
 *   scope, window, total, oldest_unresolved, newest_unresolved
 *
 * followed by two grouped tables:
 *
 *   by error_class:  <class>  <count>  <oldest>  <newest>
 *   by reason:       <reason> <count>  <oldest>  <newest>
 *
 * JSON output adds the per-group breakdown as structured arrays.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 *
 * @see docs/operations/dlq-triage-runbook.md "Inspect DLQ volume"
 * @see docs/implementation/tasks/P10-006-dlq-triage-runbook.md
 */
import {
  createKyselyDlqRecordRepository,
  type DlqRecord,
  type ListDlqRecordsFilter,
} from "@polaris/shared-destinations";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface DlqSummaryArgs {
  readonly destination?: string;
  readonly vendor?: string;
  readonly since?: string;
  readonly until?: string;
  readonly includeResolved?: boolean;
}

type SummaryScope =
  | { readonly kind: "destination"; readonly destination_id: string }
  | { readonly kind: "vendor"; readonly vendor: string };

export interface DlqSummaryStore {
  list(scope: SummaryScope, filter: ListDlqRecordsFilter): Promise<readonly DlqRecord[]>;
  close(): Promise<void>;
}

export interface DlqSummaryHooks {
  readonly openStore?: () => DlqSummaryStore;
}

/** Mirror of `LIST_DLQ_RECORDS_HARD_LIMIT` to detect truncated aggregates. */
const HARD_LIMIT = 1000;

export const dlqSummaryCommand: CommandDefinition = {
  id: "dlq.summary",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("summary")
      .description(
        "Summarize DLQ volume for a destination or vendor: total + per-error_class + per-reason. Exactly one of --destination or --vendor is required.",
      )
      .option("--destination <destination_id>", "Scope to one destination.")
      .option("--vendor <vendor>", "Scope to one vendor (across all destinations).")
      .option("--since <iso8601>", "Lower bound on published_at (inclusive ISO-8601 UTC).")
      .option("--until <iso8601>", "Upper bound on published_at (exclusive ISO-8601 UTC).")
      .option(
        "--include-resolved",
        "Include rows operators already marked resolved (default: unresolved only).",
        false,
      )
      .action(deps.runCommand({ id: "dlq.summary", mutates: false }, runDlqSummary));
  },
};

export function buildDlqSummaryRunner(hooks: DlqSummaryHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: DlqSummaryArgs, ctx: CommandContext): Promise<undefined> {
    const scope = pickScope(args);
    const filter = parseFilter(args);
    const store = openStore();
    try {
      const rows = await store.list(scope, filter);
      emit(ctx, scope, filter, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDlqSummary = buildDlqSummaryRunner();

function pickScope(args: DlqSummaryArgs): SummaryScope {
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

function parseFilter(args: DlqSummaryArgs): ListDlqRecordsFilter {
  const filter: {
    -readonly [K in keyof ListDlqRecordsFilter]: ListDlqRecordsFilter[K];
  } = { limit: HARD_LIMIT };
  if (args.since !== undefined) filter.since = parseDate("--since", args.since);
  if (args.until !== undefined) filter.until = parseDate("--until", args.until);
  if (args.includeResolved === true) filter.includeResolved = true;
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

function defaultStore(): DlqSummaryStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyDlqRecordRepository({ db: handle.db });
  return {
    list: (scope, filter) =>
      scope.kind === "destination"
        ? repo.findByDestinationId(scope.destination_id, filter)
        : repo.findByVendor(scope.vendor, filter),
    close: () => handle.close(),
  };
}

interface GroupEntry {
  readonly label: string;
  readonly count: number;
  readonly oldest: string;
  readonly newest: string;
}

interface SummaryView {
  readonly total: number;
  readonly truncated: boolean;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly byErrorClass: readonly GroupEntry[];
  readonly byReason: readonly GroupEntry[];
}

function aggregate(rows: readonly DlqRecord[]): SummaryView {
  const byErrorClass = new Map<string, { count: number; oldest: Date; newest: Date }>();
  const byReason = new Map<string, { count: number; oldest: Date; newest: Date }>();
  let oldest: Date | null = null;
  let newest: Date | null = null;

  for (const row of rows) {
    if (oldest === null || row.published_at < oldest) oldest = row.published_at;
    if (newest === null || row.published_at > newest) newest = row.published_at;
    bump(byErrorClass, row.error_class ?? "(none)", row.published_at);
    bump(byReason, row.reason, row.published_at);
  }

  return {
    total: rows.length,
    truncated: rows.length >= HARD_LIMIT,
    oldest: oldest === null ? null : oldest.toISOString(),
    newest: newest === null ? null : newest.toISOString(),
    byErrorClass: groupToEntries(byErrorClass),
    byReason: groupToEntries(byReason),
  };
}

function bump(
  map: Map<string, { count: number; oldest: Date; newest: Date }>,
  key: string,
  at: Date,
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, { count: 1, oldest: at, newest: at });
    return;
  }
  existing.count += 1;
  if (at < existing.oldest) existing.oldest = at;
  if (at > existing.newest) existing.newest = at;
}

function groupToEntries(
  map: Map<string, { count: number; oldest: Date; newest: Date }>,
): readonly GroupEntry[] {
  const entries: GroupEntry[] = [];
  for (const [label, value] of map) {
    entries.push({
      label,
      count: value.count,
      oldest: value.oldest.toISOString(),
      newest: value.newest.toISOString(),
    });
  }
  entries.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
  return entries;
}

function emit(
  ctx: CommandContext,
  scope: SummaryScope,
  filter: ListDlqRecordsFilter,
  rows: readonly DlqRecord[],
): void {
  const view = aggregate(rows);
  const scopeJson =
    scope.kind === "destination"
      ? { destination_id: scope.destination_id }
      : { vendor: scope.vendor };
  const windowJson: Record<string, unknown> = {
    include_resolved: filter.includeResolved === true,
  };
  if (filter.since !== undefined) windowJson["since"] = filter.since.toISOString();
  if (filter.until !== undefined) windowJson["until"] = filter.until.toISOString();

  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(scope, filter, view),
      json: {
        scope: scopeJson,
        window: windowJson,
        total: view.total,
        truncated: view.truncated,
        oldest: view.oldest,
        newest: view.newest,
        by_error_class: view.byErrorClass.map((entry) => ({
          error_class: entry.label,
          count: entry.count,
          oldest: entry.oldest,
          newest: entry.newest,
        })),
        by_reason: view.byReason.map((entry) => ({
          reason: entry.label,
          count: entry.count,
          oldest: entry.oldest,
          newest: entry.newest,
        })),
      },
    }),
  );
}

function renderHuman(scope: SummaryScope, filter: ListDlqRecordsFilter, view: SummaryView): string {
  const scopeLabel =
    scope.kind === "destination" ? `destination ${scope.destination_id}` : `vendor ${scope.vendor}`;
  const windowLabel = describeWindow(filter);
  if (view.total === 0) {
    return `no dlq entries for ${scopeLabel}${windowLabel === "" ? "" : ` ${windowLabel}`}`;
  }
  const lines = [
    `scope                  ${scopeLabel}`,
    `window                 ${windowLabel === "" ? "(no window filter)" : windowLabel}`,
    `total                  ${view.total}${view.truncated ? " (truncated; ≥1000 rows match — narrow --since/--until)" : ""}`,
    `oldest_unresolved      ${view.oldest ?? "-"}`,
    `newest_unresolved      ${view.newest ?? "-"}`,
    "",
    "by error_class:",
  ];
  for (const entry of view.byErrorClass) {
    lines.push(
      `  ${entry.label.padEnd(14)} count=${entry.count}  oldest=${entry.oldest}  newest=${entry.newest}`,
    );
  }
  lines.push("", "by reason:");
  for (const entry of view.byReason) {
    lines.push(
      `  ${entry.label.padEnd(20)} count=${entry.count}  oldest=${entry.oldest}  newest=${entry.newest}`,
    );
  }
  return lines.join("\n");
}

function describeWindow(filter: ListDlqRecordsFilter): string {
  const parts: string[] = [];
  if (filter.since !== undefined) parts.push(`since=${filter.since.toISOString()}`);
  if (filter.until !== undefined) parts.push(`until=${filter.until.toISOString()}`);
  if (filter.includeResolved === true) parts.push("include_resolved=true");
  return parts.join(" ");
}
