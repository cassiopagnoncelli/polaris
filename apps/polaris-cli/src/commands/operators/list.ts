/**
 * `polaris operators list [--status active|revoked]` — read-only.
 *
 * Lists operator tokens. By default includes both active and revoked rows
 * so operators can audit the full lifecycle. `--status active` narrows to
 * live rows for the common "what tokens are usable right now?" question.
 *
 * Columns:
 *
 *   operator_token_id, operator_label, status, created_at, last_used_at,
 *   revoked_at
 *
 * The argon2id `hash` NEVER appears in this output: the underlying
 * `OperatorTokenRow` view excludes the column by design, so no renderer
 * path can ever surface it. The on-wire token plaintext also never appears
 * (it exists only at issuance time, in the operator's clipboard).
 *
 * `mutates: false`: bypasses the production gate.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  listOperatorTokens,
  OPERATOR_TOKEN_STATUSES,
  type OperatorTokenRow,
  type OperatorTokenStatus,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface OperatorsListArgs {
  readonly status?: string;
}

export interface OperatorsListStore {
  list(statusFilter: OperatorTokenStatus | undefined): Promise<readonly OperatorTokenRow[]>;
  close(): Promise<void>;
}

export interface OperatorsListHooks {
  readonly openStore?: () => OperatorsListStore;
}

export const operatorsListCommand: CommandDefinition = {
  id: "operators.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List operator tokens (active + revoked by default). Never displays the raw token plaintext nor the stored hash.",
      )
      .option(
        "--status <status>",
        `Filter by status: ${OPERATOR_TOKEN_STATUSES.join(" | ")} (default: both).`,
      )
      .action(deps.runCommand({ id: "operators.list", mutates: false }, runOperatorsList));
  },
};

export function buildOperatorsListRunner(hooks: OperatorsListHooks = {}) {
  return async function runner(args: OperatorsListArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const statusFilter = validate(args);

    const store = openStore();
    try {
      const rows = await store.list(statusFilter);
      emit(ctx, statusFilter, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runOperatorsList = buildOperatorsListRunner();

function defaultStore(env: NodeJS.ProcessEnv): OperatorsListStore {
  const handle = connectDb({ env });
  return {
    list: (statusFilter) =>
      listOperatorTokens(handle.db, statusFilter !== undefined ? { statusFilter } : {}),
    close: () => handle.close(),
  };
}

function validate(args: OperatorsListArgs): OperatorTokenStatus | undefined {
  const status = args.status?.trim();
  if (status === undefined || status.length === 0) return undefined;
  if (!(OPERATOR_TOKEN_STATUSES as readonly string[]).includes(status)) {
    throw new UsageError(
      `--status must be one of: ${OPERATOR_TOKEN_STATUSES.join(", ")} (got "${status}")`,
    );
  }
  return status as OperatorTokenStatus;
}

function emit(
  ctx: CommandContext,
  statusFilter: OperatorTokenStatus | undefined,
  rows: readonly OperatorTokenRow[],
): void {
  const view = rows.map(toView);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(statusFilter, view),
      json: {
        status_filter: statusFilter ?? null,
        count: view.length,
        rows: view,
      },
    }),
  );
}

interface OperatorTokenListView {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly status: OperatorTokenStatus;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

function toView(row: OperatorTokenRow): OperatorTokenListView {
  return {
    operator_token_id: row.operator_token_id,
    operator_label: row.operator_label,
    status: row.status,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function renderHuman(
  statusFilter: OperatorTokenStatus | undefined,
  rows: readonly OperatorTokenListView[],
): string {
  const filterLabel = statusFilter === undefined ? "all" : statusFilter;
  if (rows.length === 0) {
    return `(no operator tokens matching status=${filterLabel})`;
  }
  const lines: string[] = [`status=${filterLabel} count=${rows.length}`];
  for (const row of rows) {
    const last = row.last_used_at ?? "(unused)";
    const revoked = row.revoked_at === null ? "" : ` revoked=${row.revoked_at}`;
    lines.push(
      `  ${row.operator_token_id} label=${row.operator_label} status=${row.status} created=${row.created_at} last_used=${last}${revoked}`,
    );
  }
  return lines.join("\n");
}
