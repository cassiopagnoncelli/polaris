/**
 * `polaris config get --project --env --namespace --key [--reveal]` — read-only.
 *
 * Exits non-zero when the key has no stored value, so a shell script can test
 * for "is this configured?" without parsing output. That is not the same
 * question as "is this key valid?" — an unset key with a component default is
 * perfectly healthy, which `polaris config validate` (C3) will answer instead.
 *
 * A secret value prints as `[redacted]` unless `--reveal` is passed. The flag
 * is the whole disclosure ceremony: an operator who can run this command can
 * already read the database directly, so the point is not to withhold the
 * value but to keep it out of terminal scrollback, CI logs and screen shares
 * that nobody intended to be a credential handoff.
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
  readonly reveal?: boolean;
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
      .option("--reveal", "Print a secret value instead of [redacted].")
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
      // `row.value` arrived masked from the query layer. Only a secret key
      // needs the second read; asking for a non-secret one would be a wasted
      // query and a disclosure call that discloses nothing.
      let value = row.value;
      if (args.reveal === true && row.is_secret) {
        // Logged, and at warn. This is the only path by which a stored secret
        // leaves the control plane on an operator's say-so, and the record of
        // who read what is the thing an incident responder wants afterwards.
        //
        // A log line is weaker than an `audit_records` row and is a deliberate
        // choice, not an oversight: every other read on this platform is
        // unaudited, and auditing this one alone would imply a guarantee the
        // rest of the read surface does not make. If the threat model comes to
        // demand it, the honest change is to audit reads as a class.
        ctx.logger.warn(
          {
            audit_action: "config.reveal",
            project_id: scope.projectId,
            environment: scope.environment,
            namespace,
            config_key: configKey,
            actor_source: ctx.actor.source,
            actor_label: ctx.actor.label,
          },
          "secret value revealed to an operator",
        );
        value = await store.reveal({ ...scope, namespace, configKey });
      }
      emit(ctx, row, value);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigGet = buildConfigGetRunner();

function emit(ctx: CommandContext, row: ProjectConfigRow, value: unknown): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: [
        `${row.namespace}.${row.config_key}${row.is_secret ? " [secret]" : ""}`,
        `value      ${JSON.stringify(value)}`,
        `updated    ${row.updated_at} by ${row.updated_by}`,
      ].join("\n"),
      json: {
        namespace: row.namespace,
        config_key: row.config_key,
        value,
        is_secret: row.is_secret,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      },
    }),
  );
}
