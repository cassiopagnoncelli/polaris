/**
 * `polaris audit list` — read-only.
 *
 * Lists recent audit records, filtered by any combination of:
 *
 *   --actor <label>           actor_label exact match (e.g. "cli", "cli:alice@x")
 *   --target-type <type>      target_type exact match (e.g. "destination")
 *   --target-id <id>          target_id exact match (e.g. "polaris_dst_...")
 *   --action <action>         action verb exact match (e.g. "destinations.disable")
 *   --project <project_id>    project_id exact match
 *   --env <environment>       environment exact match (development|staging|production)
 *   --since <iso>             created_at >= <iso8601 timestamp>
 *   --until <iso>             created_at <= <iso8601 timestamp>
 *   --limit <n>               max rows returned (default 50; 1..1000)
 *
 * Ordered by created_at DESC so the most recent rows surface first. JSON
 * output emits the full row shape (including `before`/`after` JSON
 * snapshots); human output emits a one-line-per-row summary, omitting the
 * snapshots so the operator-facing form stays scannable.
 *
 * `mutates: false`. Bypasses the P6-007 production gate.
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
import { renderAccordingTo } from "../../output.js";

interface AuditListArgs {
  readonly actor?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly action?: string;
  readonly project?: string;
  readonly env?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: string;
}

export interface AuditListStore {
  list(filter: ListAuditRecordsFilter): Promise<readonly AuditRecordRow[]>;
  close(): Promise<void>;
}

export interface AuditListHooks {
  readonly openStore?: () => AuditListStore;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

export const auditListCommand: CommandDefinition = {
  id: "audit.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List audit records. Filter by --actor/--target-type/--target-id/--action/--project/--env/--since/--until. " +
          "Default limit 50, max 1000.",
      )
      .option("--actor <label>", "Filter by actor_label (exact match).")
      .option(
        "--target-type <type>",
        "Filter by target_type (e.g. destination, processor_activation).",
      )
      .option("--target-id <id>", "Filter by target_id (e.g. polaris_dst_<uuid>).")
      .option("--action <verb>", "Filter by action verb (e.g. destinations.enable).")
      .option("--project <project_id>", "Filter by project_id.")
      .option("--env <environment>", "Filter by environment: development | staging | production.")
      .option("--since <iso>", "Lower-bound created_at (ISO 8601 UTC).")
      .option("--until <iso>", "Upper-bound created_at (ISO 8601 UTC).")
      .option("--limit <n>", `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`)
      .action(deps.runCommand({ id: "audit.list", mutates: false }, runAuditList));
  },
};

export function buildAuditListRunner(hooks: AuditListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: AuditListArgs, ctx: CommandContext): Promise<undefined> {
    const filter = validate(args);
    const store = openStore();
    try {
      const rows = await store.list(filter);
      emit(ctx, filter, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runAuditList = buildAuditListRunner();

function defaultStore(): AuditListStore {
  const handle = connectDb({ env: process.env });
  return {
    list: (filter) => listAuditRecords(handle.db, filter),
    close: () => handle.close(),
  };
}

function validate(args: AuditListArgs): ListAuditRecordsFilter {
  const filter: {
    actorLabel?: string;
    targetType?: string;
    targetId?: string;
    action?: string;
    projectId?: string;
    environment?: AuditEnvironment;
    since?: Date;
    until?: Date;
    limit?: number;
  } = {};
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
  const since = trim(args.since);
  if (since !== undefined) filter.since = parseIso(since, "--since");
  const until = trim(args.until);
  if (until !== undefined) filter.until = parseIso(until, "--until");
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
  } else {
    filter.limit = DEFAULT_LIMIT;
  }
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) {
    throw new UsageError(
      `--since must be before --until (got --since=${filter.since.toISOString()} --until=${filter.until.toISOString()})`,
    );
  }
  return filter;
}

function emit(
  ctx: CommandContext,
  filter: ListAuditRecordsFilter,
  rows: readonly AuditRecordRow[],
): void {
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
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(filter, rows),
      json: {
        filter: filterJson,
        count: rows.length,
        rows,
      },
    }),
  );
}

function renderHuman(filter: ListAuditRecordsFilter, rows: readonly AuditRecordRow[]): string {
  if (rows.length === 0) {
    return `(no audit records${describeFilter(filter) === "" ? "" : ` for ${describeFilter(filter)}`})`;
  }
  const lines: string[] = [
    `count=${rows.length}${describeFilter(filter) === "" ? "" : ` ${describeFilter(filter)}`}`,
  ];
  for (const row of rows) {
    const project = row.project_id ?? "-";
    const env = row.environment ?? "-";
    const reason = row.reason !== null ? ` reason="${row.reason}"` : "";
    lines.push(
      `  ${row.created_at} ${row.audit_id} ${row.action} target=${row.target_type}:${row.target_id} actor=${row.actor_label} project=${project} env=${env}${reason}`,
    );
  }
  return lines.join("\n");
}

function describeFilter(filter: ListAuditRecordsFilter): string {
  const parts: string[] = [];
  if (filter.actorLabel !== undefined) parts.push(`actor=${filter.actorLabel}`);
  if (filter.targetType !== undefined) parts.push(`target_type=${filter.targetType}`);
  if (filter.targetId !== undefined) parts.push(`target_id=${filter.targetId}`);
  if (filter.action !== undefined) parts.push(`action=${filter.action}`);
  if (filter.projectId !== undefined) parts.push(`project=${filter.projectId}`);
  if (filter.environment !== undefined) parts.push(`env=${filter.environment}`);
  if (filter.since !== undefined) parts.push(`since=${filter.since.toISOString()}`);
  if (filter.until !== undefined) parts.push(`until=${filter.until.toISOString()}`);
  return parts.join(" ");
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
