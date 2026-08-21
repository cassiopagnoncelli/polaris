/**
 * `polaris projects list` — read-only.
 *
 * Renders the materialized `projects` table when PostgreSQL is reachable.
 * When the `--from-catalog` flag is passed (or no DB connection is configured)
 * the command falls back to reading `definitions/projects/*.yaml` directly so
 * operators can inspect declarations on a fresh laptop before any sync has
 * happened.
 */

import type { ProjectFile } from "../../catalog/index.js";
import { loadCatalog, resolveCatalogRoot } from "../../catalog/index.js";
import type { ProjectRow } from "../../catalog/sync.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllProjects } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";

interface ProjectsListArgs {
  readonly fromCatalog?: boolean;
  readonly catalogRoot?: string;
}

export const projectsListCommand: CommandDefinition = {
  id: "projects.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List projects materialized in PostgreSQL (or in the catalog with --from-catalog).",
      )
      .option(
        "--from-catalog",
        "Read declarations from definitions/projects/ instead of PostgreSQL.",
      )
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      )
      .action(deps.runCommand({ id: "projects.list", mutates: false }, runProjectsList));
  },
};

async function runProjectsList(args: ProjectsListArgs, ctx: CommandContext): Promise<undefined> {
  if (args.fromCatalog === true) {
    const root = resolveCatalogRoot({ env: ctx.env, explicit: args.catalogRoot });
    const catalog = loadCatalog({ root });
    emit(ctx, "catalog", catalog.projects.map(catalogToView));
    return undefined;
  }

  const handle = connectDb({ env: ctx.env });
  try {
    const rows = await fetchAllProjects(handle.db);
    emit(ctx, "database", rows.map(rowToView));
  } finally {
    await handle.close();
  }
  return undefined;
}

interface ProjectView {
  readonly project_id: string;
  readonly display_name: string;
  readonly owner: string;
  readonly description: string;
  readonly status: string;
}

function catalogToView(project: ProjectFile): ProjectView {
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    owner: project.owner,
    description: project.description,
    status: project.status,
  };
}

function rowToView(row: ProjectRow): ProjectView {
  return {
    project_id: row.project_id,
    display_name: row.display_name,
    owner: row.owner,
    description: row.description,
    status: row.status,
  };
}

function emit(
  ctx: CommandContext,
  source: "catalog" | "database",
  rows: readonly ProjectView[],
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(source, rows),
      json: { source, count: rows.length, rows },
    }),
  );
}

function renderHuman(source: "catalog" | "database", rows: readonly ProjectView[]): string {
  if (rows.length === 0) {
    return `(no projects in ${source})`;
  }
  const lines: string[] = [`source=${source} count=${rows.length}`];
  for (const row of rows) {
    lines.push(
      `  ${row.project_id} [${row.status}] owner=${row.owner} display="${row.display_name}"`,
    );
  }
  return lines.join("\n");
}
