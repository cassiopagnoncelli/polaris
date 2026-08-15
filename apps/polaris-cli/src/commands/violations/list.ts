/**
 * `polaris violations list --project X` — read-only.
 *
 * The operator end of the schema-governance loop. A rejected event never
 * reaches the spine, so before the quarantine existed the only trace was a
 * reason code in an HTTP response the producer's error handling probably
 * swallowed. This is where the three governance questions get answered:
 *
 *   which projects are still sending a forbidden field?
 *   did a release start failing validation?
 *   is this spike new, or is it Tuesday?
 *
 * Filters:
 *
 *   --project <id>            required — the quarantine is per project
 *   --env <environment>       narrow to one environment
 *   --since <iso-timestamp>   inclusive received_at lower bound
 *   --until <iso-timestamp>   exclusive received_at upper bound
 *   --reason <code>           one batch reason code
 *   --event <name>            one event name
 *   --limit <n>               max rows (default + hard cap = 1000)
 *   --summary                 counts by reason and event instead of rows
 *
 * ## Why `--summary` exists
 *
 * The row listing answers "what exactly did they send?"; the summary
 * answers "how bad is it, and is it getting worse?". An operator asking
 * the second question with the first one's output reads a thousand rows
 * to count them, and gives up before the thousandth.
 *
 * ## Secrets
 *
 * There are none to filter. The sample was redacted in the ingester
 * before it was ever published (`buildViolationSample`), and `paths`
 * carries paths, never values. That is a property of the write path, not
 * of this command — which is why this command needs no redaction pass and
 * must not grow one, since a second implementation would be a second
 * chance to disagree about what "redacted" means.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import type { ViolationRow, ViolationSummaryRow } from "@polaris/shared-clickhouse";
import {
  createClickHouseClient,
  type ListViolationsFilter,
  VIOLATIONS_MAX_LIMIT,
} from "@polaris/shared-clickhouse";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_SERVICE_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_SERVICE_PASSWORD";

/**
 * Hard cap. IMPORTED from the reader rather than restated: the reader
 * silently clamps, so a CLI constant that drifted upward would accept a
 * `--limit` it could not honour and return fewer rows than asked for
 * without saying why. Refused here as well as clamped there so the error
 * names the flag.
 */
const MAX_LIMIT = VIOLATIONS_MAX_LIMIT;

interface ViolationsListArgs {
  readonly project?: string;
  readonly env?: string;
  readonly since?: string;
  readonly until?: string;
  readonly reason?: string;
  readonly event?: string;
  readonly limit?: string;
  readonly summary?: boolean;
}

export interface ViolationsStore {
  list(filter: ListViolationsFilter): Promise<readonly ViolationRow[]>;
  summarise(filter: ListViolationsFilter): Promise<readonly ViolationSummaryRow[]>;
  close(): Promise<void>;
}

export interface ViolationsListHooks {
  readonly openStore?: (ctx: CommandContext) => ViolationsStore;
}

export function buildViolationsListRunner(hooks: ViolationsListHooks = {}) {
  return async function runner(args: ViolationsListArgs, ctx: CommandContext): Promise<undefined> {
    const project = args.project?.trim();
    if (project === undefined || project.length === 0) {
      throw new UsageError("--project is required");
    }

    const filter = parseFilter(project, args);
    const store = (hooks.openStore ?? defaultStore)(ctx);
    try {
      if (args.summary === true) {
        emitSummary(ctx, project, await store.summarise(filter));
      } else {
        emitRows(ctx, project, await store.list(filter));
      }
    } finally {
      await store.close();
    }
    return undefined;
  };
}

export const violationsListCommand: CommandDefinition = {
  id: "violations.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List quarantined ingest rejections for a project, newest first. " +
          "Filter with --env, --since, --until, --reason, --event, --limit; " +
          "--summary counts by reason and event instead.",
      )
      .requiredOption("--project <id>")
      .option("--env <environment>", "Narrow to one environment.")
      .option("--since <iso8601>", "Lower bound on received_at (inclusive ISO-8601 UTC).")
      .option("--until <iso8601>", "Upper bound on received_at (exclusive ISO-8601 UTC).")
      .option("--reason <code>", "Filter to one batch reason code.")
      .option("--event <name>", "Filter to one event name.")
      .option("--limit <n>", `Max rows to return (1..${String(MAX_LIMIT)}).`)
      .option("--summary", "Counts by reason and event instead of individual rows.")
      // Built per invocation, like every other command's runner: the store
      // reads THIS run's environment, and one constructed at registration
      // would hold the first invocation's credentials forever.
      .action(
        deps.runCommand({ id: "violations.list", mutates: false }, buildViolationsListRunner()),
      );
  },
};

function parseFilter(project: string, args: ViolationsListArgs): ListViolationsFilter {
  const filter: {
    -readonly [K in keyof ListViolationsFilter]: ListViolationsFilter[K];
  } = { projectId: project };

  const environment = args.env?.trim();
  if (environment !== undefined && environment.length > 0) filter.environment = environment;
  if (args.since !== undefined) filter.since = parseDate("--since", args.since);
  if (args.until !== undefined) filter.until = parseDate("--until", args.until);

  const reason = args.reason?.trim();
  if (reason !== undefined && reason.length > 0) filter.reason = reason;
  const event = args.event?.trim();
  if (event !== undefined && event.length > 0) filter.event = event;

  if (args.limit !== undefined) {
    const parsed = Number.parseInt(args.limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--limit must be a positive integer (got "${args.limit}")`);
    }
    if (parsed > MAX_LIMIT) {
      throw new UsageError(
        `--limit must be at most ${String(MAX_LIMIT)} (got ${String(parsed)}). ` +
          "Narrow the window with --since / --until, or use --summary.",
      );
    }
    filter.limit = parsed;
  }

  if (filter.since !== undefined && filter.until !== undefined && filter.until < filter.since) {
    throw new UsageError(
      `--until (${filter.until.toISOString()}) must be at or after --since (${filter.since.toISOString()})`,
    );
  }
  return filter;
}

function parseDate(flag: string, raw: string): Date {
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw new UsageError(`${flag} must be an ISO-8601 UTC timestamp (got "${raw.trim()}")`);
  }
  return new Date(ms);
}

function defaultStore(ctx: CommandContext): ViolationsStore {
  const url = ctx.env[CLICKHOUSE_URL_ENV];
  if (url === undefined || url.trim().length === 0) {
    throw new UsageError(`${CLICKHOUSE_URL_ENV} is required: the quarantine lives in ClickHouse.`);
  }
  const client = createClickHouseClient({
    url,
    // SERVICE, not operator. The table contains no unredacted values by
    // construction, and requiring escalation to read it would keep it from
    // the people whose producer is failing.
    role: "service",
    credential: {
      username: ctx.env[CLICKHOUSE_USER_ENV] ?? "polaris_service",
      password: ctx.env[CLICKHOUSE_PASSWORD_ENV] ?? "",
    },
    database: "polaris",
    application: "polaris-violations-list",
  });
  return {
    list: (filter) => client.violations.list(filter),
    summarise: (filter) => client.violations.summarise(filter),
    close: () => client.close(),
  };
}

function emitRows(ctx: CommandContext, project: string, rows: readonly ViolationRow[]): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderRowsHuman(project, rows),
      json: { project_id: project, count: rows.length, violations: rows },
    }),
  );
}

function renderRowsHuman(project: string, rows: readonly ViolationRow[]): string {
  if (rows.length === 0) return `no quarantined violations for ${project}`;
  const lines = [`project_id  ${project}`, `count       ${String(rows.length)}`, ""];
  for (const row of rows) {
    lines.push(
      `${row.received_at}  ${row.reason.padEnd(26)}  event=${row.event || "-"}  ` +
        `paths=${row.paths.length > 0 ? row.paths.join(",") : "-"}  ` +
        `event_id=${row.event_id || "-"}`,
    );
    // The sample on its own line: it is JSON, and inlining it would make
    // every other column unreadable at any realistic terminal width.
    lines.push(`  ${row.redacted_sample}`);
  }
  return lines.join("\n");
}

function emitSummary(
  ctx: CommandContext,
  project: string,
  rows: readonly ViolationSummaryRow[],
): void {
  const total = rows.reduce((sum, row) => sum + row.violations, 0);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human:
        rows.length === 0
          ? `no quarantined violations for ${project}`
          : [
              `project_id  ${project}`,
              `total       ${String(total)}`,
              "",
              ...rows.map(
                (row) =>
                  `${String(row.violations).padStart(8)}  ${row.reason.padEnd(26)}  ${
                    row.event || "-"
                  }`,
              ),
            ].join("\n"),
      json: { project_id: project, total, summary: rows },
    }),
  );
}
