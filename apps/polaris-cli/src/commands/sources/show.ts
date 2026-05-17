/**
 * `polaris sources show <source_id>` — read-only.
 *
 * Renders a single source. Because `source_id` is unique only within a
 * project, the lookup may return multiple rows when an ID is reused across
 * projects. The `--project <id>` flag narrows the lookup; without it, the
 * command lists every match it found and returns the lot in JSON.
 */
import type { Command } from "commander";
import type { SourceFile } from "../../catalog/index.js";
import { loadCatalog, resolveCatalogRoot } from "../../catalog/index.js";
import type { SourceRow } from "../../catalog/sync.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, fetchSourcesById } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

interface SourcesShowOptions {
  readonly project?: string;
  readonly fromCatalog?: boolean;
  readonly catalogRoot?: string;
}

export const sourcesShowCommand: CommandDefinition = {
  id: "sources.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <source_id>")
      .description("Show one source from PostgreSQL (or the catalog with --from-catalog).")
      .option("--project <project_id>", "Narrow lookup to one project.")
      .option("--from-catalog", "Read declarations from catalog/sources/ instead of PostgreSQL.")
      .option(
        "--catalog-root <path>",
        "Override the catalog root (defaults to POLARIS_CATALOG_ROOT or repo discovery).",
      );
    cmd.action(async (sourceId: string, opts: SourcesShowOptions, command: Command) => {
      const wrapped = deps.runCommand<SourcesShowOptions>(
        { id: "sources.show", mutates: false },
        async (args, ctx) => {
          await runSourcesShow(sourceId, args, ctx);
          return undefined;
        },
      );
      await wrapped(opts, command);
    });
  },
};

async function runSourcesShow(
  sourceId: string,
  args: SourcesShowOptions,
  ctx: CommandContext,
): Promise<void> {
  if (args.fromCatalog === true) {
    const root = resolveCatalogRoot({ env: ctx.env, explicit: args.catalogRoot });
    const catalog = loadCatalog({ root });
    const matches = catalog.sources.filter((s) => {
      if (s.source_id !== sourceId) return false;
      if (args.project !== undefined && s.project_id !== args.project) return false;
      return true;
    });
    if (matches.length === 0) {
      throw new UsageError(
        args.project !== undefined
          ? `source "${sourceId}" is not declared under catalog/sources/${args.project}/`
          : `source "${sourceId}" is not declared under any catalog/sources/<project>/`,
      );
    }
    emit(ctx, "catalog", matches.map(catalogToView));
    return;
  }

  const handle = connectDb({ env: ctx.env });
  try {
    const rows = await fetchSourcesById(handle.db, sourceId);
    const filtered =
      args.project !== undefined ? rows.filter((r) => r.project_id === args.project) : rows;
    if (filtered.length === 0) {
      throw new UsageError(
        args.project !== undefined
          ? `source "${sourceId}" is not present in PostgreSQL for project "${args.project}". Run \`polaris sources sync\` first.`
          : `source "${sourceId}" is not present in PostgreSQL. Run \`polaris sources sync\` first.`,
      );
    }
    emit(ctx, "database", filtered.map(rowToView));
  } finally {
    await handle.close();
  }
}

interface SourceView {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly owner: string;
  readonly description: string;
  readonly runtime: string;
  readonly status: string;
  readonly allowed_environments: readonly string[];
}

function catalogToView(source: SourceFile): SourceView {
  return {
    project_id: source.project_id,
    source_id: source.source_id,
    source_type: source.source_type,
    owner: source.owner,
    description: source.description,
    runtime: source.runtime,
    status: source.status,
    allowed_environments: source.allowed_environments,
  };
}

function rowToView(row: SourceRow): SourceView {
  return {
    project_id: row.project_id,
    source_id: row.source_id,
    source_type: row.source_type,
    owner: row.owner,
    description: row.description,
    runtime: row.runtime,
    status: row.status,
    allowed_environments: row.allowed_environments,
  };
}

function emit(
  ctx: CommandContext,
  source: "catalog" | "database",
  rows: readonly SourceView[],
): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(source, rows),
      json: { source, count: rows.length, rows },
    }),
  );
}

function renderHuman(source: "catalog" | "database", rows: readonly SourceView[]): string {
  if (rows.length === 1) {
    const row = rows[0];
    if (row === undefined) return "(no rows)";
    return [
      `project_id           ${row.project_id}`,
      `source_id            ${row.source_id}`,
      `source_type          ${row.source_type}`,
      `owner                ${row.owner}`,
      `runtime              ${row.runtime}`,
      `status               ${row.status}`,
      `allowed_environments ${row.allowed_environments.join(",")}`,
      `source               ${source}`,
      `description          ${row.description}`,
    ].join("\n");
  }
  const lines: string[] = [`source=${source} count=${rows.length}`];
  for (const row of rows) {
    lines.push(
      `  ${row.project_id}/${row.source_id} type=${row.source_type} runtime=${row.runtime} status=${row.status} envs=[${row.allowed_environments.join(",")}]`,
    );
  }
  return lines.join("\n");
}
