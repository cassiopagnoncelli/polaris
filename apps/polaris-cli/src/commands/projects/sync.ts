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
import { v7 as uuidv7 } from "uuid";
import {
  loadCatalog,
  type ProjectDiffRow,
  type ProjectsSyncPlan,
  planProjectsSync,
  resolveCatalogRoot,
} from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllProjects, syncProjectsWithAudit } from "../../db/index.js";
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
  const root = resolveCatalogRoot({ env: ctx.env, explicit: args.catalogRoot });
  const catalog = loadCatalog({ root });

  const handle = connectDb({ env: ctx.env });
  try {
    const current = await fetchAllProjects(handle.db);
    const plan = planProjectsSync(catalog.projects, current);

    if (args.dryRun === true) {
      emit(ctx, plan, { applied: false });
      return undefined;
    }

    await applyPlan(handle.db, plan, ctx, current.length);
    emit(ctx, plan, { applied: true });
  } finally {
    await handle.close();
  }
  return undefined;
}

async function applyPlan(
  db: Kysely<Database>,
  plan: ProjectsSyncPlan,
  ctx: CommandContext,
  existingTotal: number,
): Promise<void> {
  // One audit row for the whole run, not one per row changed. A sync that
  // touches forty projects is a single operator action taken against a single
  // catalog revision; forty rows would bury that and make the log unreadable
  // at exactly the moment someone is trying to work out what changed. The
  // counts and affected ids go in the snapshot.
  //
  // The write and the audit row share one transaction: a half-applied sync
  // leaves the mirror describing a state no catalog revision ever had.
  await syncProjectsWithAudit(
    db,
    {
      to_create: plan.to_create.map((row) => row.desired),
      to_update: plan.to_update.map((row) => row.desired),
    },
    { total: existingTotal },
    {
      auditId: `polaris_aud_${uuidv7()}`,
      actorSource: ctx.actor.source,
      actorLabel: ctx.actor.label,
      occurredAt: new Date(),
    },
  );
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
