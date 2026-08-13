/**
 * `polaris config get --project --env --namespace --key` — read-only.
 *
 * Exits non-zero when the key has no stored value, so a shell script can test
 * for "is this configured?" without parsing output. That is not the same
 * question as "is this key valid?" — an unset key with a component default is
 * perfectly healthy, which `polaris config validate` (C3) will answer instead.
 */

import type { CommandContext, CommandDefinition } from "../../command.js";
import type { ProjectConfigRow } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import {
  requireConfigKey,
  requireEnvironment,
  requireNamespace,
  requireProject,
  SUPPORTED_ENVIRONMENTS,
} from "./value.js";

interface ConfigGetArgs {
  readonly project?: string;
  readonly env?: string;
  readonly namespace?: string;
  readonly key?: string;
}

export const configGetCommand: CommandDefinition = {
  id: "config.get",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("get")
      .description("Show one stored configuration value.")
      .requiredOption("--project <project_id>", "Project to read.")
      .requiredOption("--env <environment>", `Environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`)
      .requiredOption("--namespace <namespace>", "Component namespace, e.g. meta-capi.")
      .requiredOption("--key <config_key>", "Key within the namespace.")
      .action(deps.runCommand({ id: "config.get", mutates: false }, runConfigGet));
  },
};

export function buildConfigGetRunner(hooks: ConfigHooks = {}) {
  return async function runner(args: ConfigGetArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const scope = {
      projectId: requireProject(args.project),
      environment: requireEnvironment(args.env),
    };
    const namespace = requireNamespace(args.namespace);
    const configKey = requireConfigKey(args.key);

    const store = openStore();
    try {
      const rows = await store.list(scope, namespace);
      const row = rows.find((candidate) => candidate.config_key === configKey);
      if (row === undefined) {
        throw new UsageError(
          `no stored value for ${namespace}.${configKey} in ${scope.projectId}/${scope.environment}`,
        );
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigGet = buildConfigGetRunner();

function emit(ctx: CommandContext, row: ProjectConfigRow): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: [
        `${row.namespace}.${row.config_key}${row.is_secret_ref ? " [secret-ref]" : ""}`,
        `value      ${JSON.stringify(row.value)}`,
        `updated    ${row.updated_at} by ${row.updated_by}`,
      ].join("\n"),
      json: {
        namespace: row.namespace,
        config_key: row.config_key,
        value: row.value,
        is_secret_ref: row.is_secret_ref,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      },
    }),
  );
}
