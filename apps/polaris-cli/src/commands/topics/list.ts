/**
 * `polaris topics list [--project <id>] [--env <env>]` — read-only.
 *
 * Lists currently-active topic isolations. Optional filters narrow by
 * project and / or environment. The output table mirrors the columns
 * the operational dashboards highlight: project, environment, family,
 * concrete topic, activator, reason, activated-at.
 *
 * Deactivated history rows are NOT surfaced by this command — they
 * remain on the table for audit / forensic queries but the
 * cutover-time view is "what is isolated right now?". To reconstruct
 * history, query `audit_records` for `topics.isolate` /
 * `topics.deisolate` actions, or use the `polaris export` surface.
 *
 * `mutates: false`. The P6-007 gate is a no-op for read-only commands.
 */
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { listActiveIsolations, type TopicIsolationRow } from "../../db/topic-isolations.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;

export interface TopicsListStore {
  list(filter: TopicsListFilter): Promise<TopicIsolationRow[]>;
  close(): Promise<void>;
}

export interface TopicsListFilter {
  readonly projectId?: string;
  readonly environment?: string;
}

export interface TopicsListHooks {
  readonly openStore?: () => TopicsListStore;
}

interface TopicsListArgs {
  readonly project?: string;
  readonly env?: string;
}

export const topicsListCommand: CommandDefinition = {
  id: "topics.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List currently-active topic isolations.")
      .option("--project <project_id>", "Filter by project_id.")
      .option(
        "--env <environment>",
        `Filter by environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`,
      )
      .action(deps.runCommand({ id: "topics.list", mutates: false }, runTopicsList));
  },
};

export function buildTopicsListRunner(hooks: TopicsListHooks = {}) {
  return async function runner(args: TopicsListArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const filter: TopicsListFilter = {};
    if (args.project !== undefined) {
      const trimmed = args.project.trim();
      if (trimmed.length === 0) throw new UsageError("--project must be non-empty when supplied");
      (filter as { projectId?: string }).projectId = trimmed;
    }
    if (args.env !== undefined) {
      const trimmed = args.env.trim();
      if (trimmed.length === 0) throw new UsageError("--env must be non-empty when supplied");
      if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(trimmed)) {
        throw new UsageError(
          `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${trimmed}")`,
        );
      }
      (filter as { environment?: string }).environment = trimmed;
    }

    const store = openStore();
    try {
      const rows = await store.list(filter);
      emit(ctx, rows);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runTopicsList = buildTopicsListRunner();

function defaultStore(env: NodeJS.ProcessEnv): TopicsListStore {
  const handle = connectDb({ env });
  return {
    list: (filter) =>
      listActiveIsolations(handle.db, {
        ...(filter.projectId !== undefined ? { project_id: filter.projectId } : {}),
        ...(filter.environment !== undefined ? { environment: filter.environment } : {}),
      }),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, rows: ReadonlyArray<TopicIsolationRow>): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(rows),
      json: rows.map((row) => ({
        topic_isolation_id: row.id,
        project_id: row.project_id,
        environment: row.environment,
        topic_family: row.topic_family,
        concrete_topic: row.concrete_topic,
        activated_at: row.activated_at,
        reason: row.reason,
        actor_id: row.actor_id,
      })),
    }),
  );
}

function renderHuman(rows: ReadonlyArray<TopicIsolationRow>): string {
  if (rows.length === 0) {
    return "no active topic isolations.";
  }
  const header = ["PROJECT", "ENV", "FAMILY", "CONCRETE_TOPIC", "ACTIVATED_AT", "ACTOR", "REASON"];
  const lines: string[][] = [header];
  for (const row of rows) {
    lines.push([
      row.project_id,
      row.environment,
      row.topic_family,
      row.concrete_topic,
      row.activated_at,
      row.actor_id,
      row.reason.length > 60 ? `${row.reason.slice(0, 57)}...` : row.reason,
    ]);
  }
  const widths = header.map((_, col) => Math.max(...lines.map((line) => (line[col] ?? "").length)));
  return lines
    .map((line) =>
      line
        .map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
