/**
 * `polaris sources list [--project <id>]` — read-only.
 *
 * Mirrors `projects list` but for the `sources` table. Filters by project
 * when `--project` is set. Falls back to reading catalog files with
 * `--from-catalog` so operators can inspect declarations without a DB.
 */

import type { SourceFile } from "../../catalog/index.js";
import { loadCatalog, resolveCatalogRoot } from "../../catalog/index.js";
import type { SourceRow } from "../../catalog/sync.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllSources, fetchSourcesByProject } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";

interface SourcesListArgs {
  readonly project?: string;
  readonly fromCatalog?: boolean;
  readonly catalogRoot?: string;
}

export const sourcesListCommand: CommandDefinition = {
  id: "sources.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List sources materialized in PostgreSQL (or in the catalog with --from-catalog).",
      )
      .option("--project <project_id>", "Filter results to one project.")
      .option("--from-catalog", "Read declarations from catalog/sources/ instead of PostgreSQL.")
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      )
      .action(deps.runCommand({ id: "sources.list", mutates: false }, runSourcesList));
  },
};

async function runSourcesList(args: SourcesListArgs, ctx: CommandContext): Promise<undefined> {
  if (args.fromCatalog === true) {
    const root = resolveCatalogRoot({ explicit: args.catalogRoot });
    const catalog = loadCatalog({ root });
    const filtered =
      args.project !== undefined
        ? catalog.sources.filter((s) => s.project_id === args.project)
        : catalog.sources;
    emit(ctx, "catalog", filtered.map(catalogToView), args.project);
    return undefined;
  }

  const handle = connectDb({ env: ctx.env });
  try {
    const rows =
      args.project !== undefined
        ? await fetchSourcesByProject(handle.db, args.project)
        : await fetchAllSources(handle.db);
    emit(ctx, "database", rows.map(rowToView), args.project);
  } finally {
    await handle.close();
  }
  return undefined;
}

interface SourceView {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly owner: string;
  readonly runtime: string;
  readonly status: string;
  readonly allowed_environments: readonly string[];
  readonly description: string;
}

function catalogToView(source: SourceFile): SourceView {
  return {
    project_id: source.project_id,
    source_id: source.source_id,
    source_type: source.source_type,
    owner: source.owner,
    runtime: source.runtime,
    status: source.status,
    allowed_environments: source.allowed_environments,
    description: source.description,
  };
}

function rowToView(row: SourceRow): SourceView {
  return {
    project_id: row.project_id,
    source_id: row.source_id,
    source_type: row.source_type,
    owner: row.owner,
    runtime: row.runtime,
    status: row.status,
    allowed_environments: row.allowed_environments,
    description: row.description,
  };
}

function emit(
  ctx: CommandContext,
  source: "catalog" | "database",
  rows: readonly SourceView[],
  projectFilter: string | undefined,
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(source, rows, projectFilter),
      json: {
        source,
        filter: projectFilter ? { project_id: projectFilter } : null,
        count: rows.length,
        rows,
      },
    }),
  );
}

function renderHuman(
  source: "catalog" | "database",
  rows: readonly SourceView[],
  projectFilter: string | undefined,
): string {
  if (rows.length === 0) {
    return projectFilter !== undefined
      ? `(no sources in ${source} for project ${projectFilter})`
      : `(no sources in ${source})`;
  }
  const header =
    projectFilter !== undefined
      ? `source=${source} project=${projectFilter} count=${rows.length}`
      : `source=${source} count=${rows.length}`;
  const lines: string[] = [header];
  for (const row of rows) {
    lines.push(
      `  ${row.project_id}/${row.source_id} type=${row.source_type} runtime=${row.runtime} status=${row.status} envs=[${row.allowed_environments.join(",")}]`,
    );
  }
  return lines.join("\n");
}
