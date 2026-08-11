/**
 * `polaris sources sync` — mutates: true.
 *
 * Diffs `catalog/sources/<project_id>/<source_id>.yaml` declarations against
 * the `sources` PostgreSQL table and either prints the plan (`--dry-run`) or
 * applies it inside a single transaction.
 *
 * Like `projects sync`, catalog absence is NOT a delete signal in v1. The
 * planner is pure; the command wires it to the database.
 */
import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";
import {
  loadCatalog,
  planSourcesSync,
  resolveCatalogRoot,
  type SourceDiffRow,
  type SourcesSyncPlan,
} from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllSources, syncSourcesWithAudit } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";

interface SourcesSyncArgs {
  readonly dryRun?: boolean;
  readonly catalogRoot?: string;
}

export const sourcesSyncCommand: CommandDefinition = {
  id: "sources.sync",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("sync")
      .description("Materialize catalog/sources/**/*.yaml into PostgreSQL.")
      .option("--dry-run", "Show the planned diff without writing to PostgreSQL.")
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      )
      .action(deps.runCommand({ id: "sources.sync", mutates: true }, runSourcesSync));
  },
};

async function runSourcesSync(args: SourcesSyncArgs, ctx: CommandContext): Promise<undefined> {
  const root = resolveCatalogRoot({ env: ctx.env, explicit: args.catalogRoot });
  const catalog = loadCatalog({ root });

  const handle = connectDb({ env: ctx.env });
  try {
    const current = await fetchAllSources(handle.db);
    const plan = planSourcesSync(catalog.sources, current);

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
  plan: SourcesSyncPlan,
  ctx: CommandContext,
  existingTotal: number,
): Promise<void> {
  // One audit row for the whole run, not one per row changed. A sync that
  // touches forty sources is a single operator action taken against a single
  // catalog revision; forty rows would bury that and make the log unreadable
  // at exactly the moment someone is trying to work out what changed. The
  // counts and affected ids go in the snapshot.
  //
  // The write and the audit row share one transaction: a half-applied sync
  // leaves the mirror describing a state no catalog revision ever had.
  await syncSourcesWithAudit(
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
  plan: SourcesSyncPlan,
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

function diffToJson(diff: SourceDiffRow): {
  readonly project_id: string;
  readonly source_id: string;
  readonly action: string;
  readonly desired: SourceDiffRow["desired"];
  readonly current: SourceDiffRow["current"];
} {
  return {
    project_id: diff.project_id,
    source_id: diff.source_id,
    action: diff.action,
    desired: diff.desired,
    current: diff.current,
  };
}

function renderHuman(plan: SourcesSyncPlan, meta: { readonly applied: boolean }): string {
  const lines: string[] = [];
  lines.push(
    meta.applied
      ? `sources sync applied: +${plan.to_create.length} ~${plan.to_update.length} =${plan.unchanged.length}`
      : `sources sync dry-run: +${plan.to_create.length} ~${plan.to_update.length} =${plan.unchanged.length}`,
  );
  for (const row of plan.to_create) {
    lines.push(`  + ${row.project_id}/${row.source_id}`);
  }
  for (const row of plan.to_update) {
    lines.push(`  ~ ${row.project_id}/${row.source_id}`);
  }
  if (plan.unchanged.length > 0) {
    lines.push(`  ${plan.unchanged.length} unchanged`);
  }
  return lines.join("\n");
}
