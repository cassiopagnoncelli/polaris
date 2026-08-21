/**
 * `polaris projects show <project_id>` — read-only.
 *
 * Shows the materialized PostgreSQL row when available; falls back to the
 * catalog declaration with `--from-catalog`. Returns exit code 2 (usage)
 * when the project is unknown so scripts can detect missing IDs without
 * parsing prose.
 */
import type { Command } from "commander";
import { loadCatalog, resolveCatalogRoot } from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchAllProjects } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface ProjectsShowOptions {
  readonly fromCatalog?: boolean;
  readonly catalogRoot?: string;
}

export const projectsShowCommand: CommandDefinition = {
  id: "projects.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <project_id>")
      .description("Show one project from PostgreSQL (or the catalog with --from-catalog).")
      .option(
        "--from-catalog",
        "Read declaration from definitions/projects/ instead of PostgreSQL.",
      )
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      );
    cmd.action(async (projectId: string, opts: ProjectsShowOptions, command: Command) => {
      const wrapped = deps.runCommand<ProjectsShowOptions>(
        { id: "projects.show", mutates: false },
        async (args, ctx) => {
          await runProjectsShow(projectId, args, ctx);
          return undefined;
        },
      );
      await wrapped(opts, command);
    });
  },
};

async function runProjectsShow(
  projectId: string,
  args: ProjectsShowOptions,
  ctx: CommandContext,
): Promise<void> {
  if (args.fromCatalog === true) {
    const root = resolveCatalogRoot({ env: ctx.env, explicit: args.catalogRoot });
    const catalog = loadCatalog({ root });
    const match = catalog.projects.find((p) => p.project_id === projectId);
    if (match === undefined) {
      throw new UsageError(`project "${projectId}" is not declared under definitions/projects/`);
    }
    emit(ctx, "catalog", match);
    return;
  }

  const handle = connectDb({ env: ctx.env });
  try {
    const rows = await fetchAllProjects(handle.db);
    const row = rows.find((r) => r.project_id === projectId);
    if (row === undefined) {
      throw new UsageError(
        `project "${projectId}" is not present in PostgreSQL. Run \`polaris projects sync\` first.`,
      );
    }
    emit(ctx, "database", row);
  } finally {
    await handle.close();
  }
}

function emit(
  ctx: CommandContext,
  source: "catalog" | "database",
  row: {
    readonly project_id: string;
    readonly display_name: string;
    readonly owner: string;
    readonly description: string;
    readonly status: string;
  },
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(source, row),
      json: { source, project: row },
    }),
  );
}

function renderHuman(
  source: "catalog" | "database",
  row: {
    readonly project_id: string;
    readonly display_name: string;
    readonly owner: string;
    readonly description: string;
    readonly status: string;
  },
): string {
  return [
    `project_id   ${row.project_id}`,
    `display_name ${row.display_name}`,
    `owner        ${row.owner}`,
    `status       ${row.status}`,
    `source       ${source}`,
    `description  ${row.description}`,
  ].join("\n");
}
