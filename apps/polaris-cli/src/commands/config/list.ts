/**
 * `polaris config list --project <id> --env <env> [--namespace <ns>]`
 * — read-only.
 *
 * Renders the stored values for a scope. Secret-typed rows show their
 * `<provider>:<ref>` pointer and are marked as such; a resolved value never
 * reaches this surface, because nothing on the write side ever stored one.
 */

import type { CommandContext, CommandDefinition } from "../../command.js";
import type { ProjectConfigRow } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import { requireEnvironment, requireProject, SUPPORTED_ENVIRONMENTS } from "./value.js";

interface ConfigListArgs {
  readonly project?: string;
  readonly env?: string;
  readonly namespace?: string;
}

export const configListCommand: CommandDefinition = {
  id: "config.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List stored configuration values for a project and environment.")
      .requiredOption("--project <project_id>", "Project to read.")
      .requiredOption("--env <environment>", `Environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`)
      .option("--namespace <namespace>", "Restrict to one component's namespace.")
      .action(deps.runCommand({ id: "config.list", mutates: false }, runConfigList));
  },
};

export function buildConfigListRunner(hooks: ConfigHooks = {}) {
  return async function runner(args: ConfigListArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const scope = {
      projectId: requireProject(args.project),
      environment: requireEnvironment(args.env),
    };
    const namespace = args.namespace?.trim();

    const store = openStore();
    try {
      const rows = await store.list(
        scope,
        namespace !== undefined && namespace.length > 0 ? namespace : undefined,
      );
      const version = await store.version(scope);
      emit(ctx, rows, version);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigList = buildConfigListRunner();

function emit(ctx: CommandContext, rows: readonly ProjectConfigRow[], version: bigint): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(rows, version),
      json: {
        version: version.toString(),
        values: rows.map((row) => ({
          namespace: row.namespace,
          config_key: row.config_key,
          value: row.value,
          is_secret_ref: row.is_secret_ref,
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        })),
      },
    }),
  );
}

function renderHuman(rows: readonly ProjectConfigRow[], version: bigint): string {
  if (rows.length === 0) {
    return `no stored values (version ${version.toString()}); every key falls back to its component default`;
  }
  const lines = [`version ${version.toString()}`, ""];
  for (const row of rows) {
    const marker = row.is_secret_ref ? " [secret-ref]" : "";
    lines.push(
      `${row.namespace}.${row.config_key}${marker} = ${JSON.stringify(row.value)}  (${row.updated_by})`,
    );
  }
  return lines.join("\n");
}
