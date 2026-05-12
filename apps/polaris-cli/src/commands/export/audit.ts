/**
 * `polaris export audit --since <iso> --until <iso> [--format json|ndjson]
 *  [--actor <label>] [--target-type <type>] [--target-id <id>]
 *  [--action <verb>] [--project <id>] [--env <env>] [--limit <n>]` — read-only.
 *
 * Bulk export of audit rows from the `audit_records` table. Two output
 * formats:
 *
 *   - `json` (default): a single JSON document
 *     `{ filter, count, audit_records: [...] }` — pretty-printed, friendly
 *     for diff and review.
 *
 *   - `ndjson`: one JSON object per line, no envelope. Designed for
 *     piping into log-aggregation tooling (Loki, Grafana, Elasticsearch)
 *     and downstream batch processors that consume newline-delimited
 *     JSON.
 *
 * The filter surface mirrors `polaris audit list` so an operator can
 * preview with `audit list` and then re-run with `export audit` once the
 * filter is right. Default limit is 1000 (an order of magnitude higher
 * than `audit list`'s 50) since exports are pipeline material; the max is
 * 100_000 for safety.
 *
 * `mutates: false`.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  AUDIT_ENVIRONMENTS,
  type AuditEnvironment,
  type AuditRecordRow,
  connectDb,
  listAuditRecords,
  type ListAuditRecordsFilter,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderJson } from "../../output.js";

const SUPPORTED_FORMATS = ["json", "ndjson"] as const;
type ExportFormat = (typeof SUPPORTED_FORMATS)[number];

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 100_000;

interface ExportAuditArgs {
  readonly since?: string;
  readonly until?: string;
  readonly format?: string;
  readonly actor?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly action?: string;
  readonly project?: string;
  readonly env?: string;
  readonly limit?: string;
}

export interface ExportAuditStore {
  list(filter: ListAuditRecordsFilter): Promise<readonly AuditRecordRow[]>;
  close(): Promise<void>;
}

export interface ExportAuditHooks {
  readonly openStore?: () => ExportAuditStore;
}

export const exportAuditCommand: CommandDefinition = {
  id: "export.audit",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("audit")
      .description(
        "Bulk export of audit records as JSON (default) or NDJSON. Filters mirror `polaris audit list`. Default limit 1000, max 100000.",
      )
      .requiredOption("--since <iso>", "Lower-bound created_at (ISO 8601 UTC).")
      .requiredOption("--until <iso>", "Upper-bound created_at (ISO 8601 UTC).")
      .option(
        `--format <format>`,
        `Output format: ${SUPPORTED_FORMATS.join(" | ")} (default: json).`,
      )
      .option("--actor <label>", "Filter by actor_label.")
      .option("--target-type <type>", "Filter by target_type.")
      .option("--target-id <id>", "Filter by target_id.")
      .option("--action <verb>", "Filter by action verb.")
      .option("--project <project_id>", "Filter by project_id.")
      .option("--env <environment>", "Filter by environment.")
      .option("--limit <n>", `Max rows to export (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`)
      .action(deps.runCommand({ id: "export.audit", mutates: false }, runExportAudit));
  },
};

export function buildExportAuditRunner(hooks: ExportAuditHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: ExportAuditArgs, ctx: CommandContext): Promise<undefined> {
    const { filter, format } = validate(args);
    const store = openStore();
    try {
      const rows = await store.list(filter);
      emit(ctx, filter, format, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runExportAudit = buildExportAuditRunner();

function defaultStore(): ExportAuditStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (filter) => listAuditRecords(handle.db, filter),
    close: () => handle.close(),
  };
}

function validate(args: ExportAuditArgs): {
  filter: ListAuditRecordsFilter;
  format: ExportFormat;
} {
  const since = trim(args.since);
  const until = trim(args.until);
  if (since === undefined) throw new UsageError("--since is required");
  if (until === undefined) throw new UsageError("--until is required");
  const sinceDate = parseIso(since, "--since");
  const untilDate = parseIso(until, "--until");
  if (sinceDate > untilDate) {
    throw new UsageError(
      `--since must be before --until (got --since=${sinceDate.toISOString()} --until=${untilDate.toISOString()})`,
    );
  }

  const filter: {
    actorLabel?: string;
    targetType?: string;
    targetId?: string;
    action?: string;
    projectId?: string;
    environment?: AuditEnvironment;
    since: Date;
    until: Date;
    limit: number;
  } = {
    since: sinceDate,
    until: untilDate,
    limit: DEFAULT_LIMIT,
  };
  const actor = trim(args.actor);
  if (actor !== undefined) filter.actorLabel = actor;
  const targetType = trim(args.targetType);
  if (targetType !== undefined) filter.targetType = targetType;
  const targetId = trim(args.targetId);
  if (targetId !== undefined) filter.targetId = targetId;
  const action = trim(args.action);
  if (action !== undefined) filter.action = action;
  const project = trim(args.project);
  if (project !== undefined) filter.projectId = project;
  const env = trim(args.env);
  if (env !== undefined) {
    if (!(AUDIT_ENVIRONMENTS as ReadonlyArray<string>).includes(env)) {
      throw new UsageError(`--env must be one of: ${AUDIT_ENVIRONMENTS.join(", ")} (got "${env}")`);
    }
    filter.environment = env as AuditEnvironment;
  }
  const limit = trim(args.limit);
  if (limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(limit)) {
      throw new UsageError(`--limit must be a positive integer (got "${limit}")`);
    }
    const parsed = Number.parseInt(limit, 10);
    if (parsed > MAX_LIMIT) {
      throw new UsageError(`--limit must be ${MAX_LIMIT} or fewer (got ${parsed})`);
    }
    filter.limit = parsed;
  }

  const format = parseFormat(args.format);
  return { filter, format };
}

function parseFormat(raw: string | undefined): ExportFormat {
  if (raw === undefined) return "json";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "json";
  if (!(SUPPORTED_FORMATS as ReadonlyArray<string>).includes(trimmed)) {
    throw new UsageError(
      `--format must be one of: ${SUPPORTED_FORMATS.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as ExportFormat;
}

function emit(
  ctx: CommandContext,
  filter: ListAuditRecordsFilter,
  format: ExportFormat,
  rows: readonly AuditRecordRow[],
): void {
  if (format === "ndjson") {
    // One JSON object per line, no envelope. The newline at the end of
    // each row matches the de-facto NDJSON convention and lets downstream
    // pipelines treat the stream as line-delimited records.
    for (const row of rows) {
      ctx.output.writeOut(`${JSON.stringify(row)}\n`);
    }
    return;
  }
  const filterJson: Record<string, unknown> = {};
  if (filter.actorLabel !== undefined) filterJson["actor_label"] = filter.actorLabel;
  if (filter.targetType !== undefined) filterJson["target_type"] = filter.targetType;
  if (filter.targetId !== undefined) filterJson["target_id"] = filter.targetId;
  if (filter.action !== undefined) filterJson["action"] = filter.action;
  if (filter.projectId !== undefined) filterJson["project_id"] = filter.projectId;
  if (filter.environment !== undefined) filterJson["environment"] = filter.environment;
  if (filter.since !== undefined) filterJson["since"] = filter.since.toISOString();
  if (filter.until !== undefined) filterJson["until"] = filter.until.toISOString();
  if (filter.limit !== undefined) filterJson["limit"] = filter.limit;

  ctx.output.writeOut(
    renderJson({
      filter: filterJson,
      count: rows.length,
      audit_records: rows,
    }),
  );
}

function parseIso(value: string, flag: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`${flag} must be a valid ISO 8601 timestamp (got "${value}")`);
  }
  return parsed;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
