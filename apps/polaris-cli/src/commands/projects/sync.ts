/**
 * `polaris projects sync` — mutates: true.
 *
 * Materializes `catalog/projects/*.yaml` declarations into the `projects`
 * PostgreSQL table. The planner is pure — it builds a diff first, then the
 * command either prints the diff (`--dry-run`) or applies it inside a single
 * transaction.
 *
 * `mutates` is set to `true` so when the production-mutation gate from
 * P6-007 lands, this command is gated automatically.
 *
 * Source catalog absence is NOT a delete signal in v1. Removing projects is a
 * separate workflow because removal would cascade through every FK referencing
 * the row. That capability is out of scope here.
 */
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import {
  loadCatalog,
  type ProjectDiffRow,
  type ProjectsSyncPlan,
  planProjectsSync,
  resolveCatalogRoot,
} from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllProjects, insertProject, updateProject } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";

interface ProjectsSyncArgs {
  readonly dryRun?: boolean;
  readonly catalogRoot?: string;
}

export const projectsSyncCommand: CommandDefinition = {
  id: "projects.sync",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("sync")
      .description("Materialize catalog/projects/*.yaml into PostgreSQL.")
      .option("--dry-run", "Show the planned diff without writing to PostgreSQL.")
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      )
      .action(deps.runCommand({ id: "projects.sync", mutates: true }, runProjectsSync));
  },
};

async function runProjectsSync(args: ProjectsSyncArgs, ctx: CommandContext): Promise<undefined> {
  const root = resolveCatalogRoot({ explicit: args.catalogRoot });
  const catalog = loadCatalog({ root });

  const handle = connectDb({ env: process.env });
  try {
    const current = await fetchAllProjects(handle.db);
    const plan = planProjectsSync(catalog.projects, current);

    if (args.dryRun === true) {
      emit(ctx, plan, { applied: false });
      return undefined;
    }

    await applyPlan(handle.db, plan);
    emit(ctx, plan, { applied: true });
  } finally {
    await handle.close();
  }
  return undefined;
}

async function applyPlan(db: Kysely<Database>, plan: ProjectsSyncPlan): Promise<void> {
  if (plan.to_create.length === 0 && plan.to_update.length === 0) return;
  await db.transaction().execute(async (trx) => {
    for (const row of plan.to_create) {
      await insertProject(trx, row.desired);
    }
    for (const row of plan.to_update) {
      await updateProject(trx, row.desired);
    }
  });
}

function emit(
  ctx: CommandContext,
  plan: ProjectsSyncPlan,
  meta: { readonly applied: boolean },
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(plan, meta),
      json: {
        applied: meta.applied,
        summary: {
          to_create: plan.to_create.length,
          to_update: plan.to_update.length,
          unchanged: plan.unchanged.length,
        },
        to_create: plan.to_create.map(diffToJson),
        to_update: plan.to_update.map(diffToJson),
        unchanged: plan.unchanged.map(diffToJson),
      },
    }),
  );
}

function diffToJson(diff: ProjectDiffRow): {
  readonly project_id: string;
  readonly action: string;
  readonly desired: ProjectDiffRow["desired"];
  readonly current: ProjectDiffRow["current"];
} {
  return {
    project_id: diff.project_id,
    action: diff.action,
    desired: diff.desired,
    current: diff.current,
  };
}

function renderHuman(plan: ProjectsSyncPlan, meta: { readonly applied: boolean }): string {
  const lines: string[] = [];
  lines.push(
    meta.applied
      ? `projects sync applied: +${plan.to_create.length} ~${plan.to_update.length} =${plan.unchanged.length}`
      : `projects sync dry-run: +${plan.to_create.length} ~${plan.to_update.length} =${plan.unchanged.length}`,
  );
  for (const row of plan.to_create) {
    lines.push(`  + ${row.project_id}`);
  }
  for (const row of plan.to_update) {
    lines.push(`  ~ ${row.project_id}`);
  }
  if (plan.unchanged.length > 0) {
    lines.push(`  ${plan.unchanged.length} unchanged`);
  }
  return lines.join("\n");
}
