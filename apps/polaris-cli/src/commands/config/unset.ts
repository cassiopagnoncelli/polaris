/**
 * `polaris config unset --project --env --namespace --key --reason` — mutating.
 *
 * Removes a stored value so the key reverts to its component default.
 * Idempotent: unsetting a key that has no stored value prints `not set` and
 * exits 0, writing no audit row — the log records transitions, not clicks.
 */

import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import {
  requireConfigKey,
  requireEnvironment,
  requireNamespace,
  requireProject,
  requireReason,
  SUPPORTED_ENVIRONMENTS,
} from "./value.js";

interface ConfigUnsetArgs {
  readonly project?: string;
  readonly env?: string;
  readonly namespace?: string;
  readonly key?: string;
  readonly reason?: string;
}

export const configUnsetCommand: CommandDefinition = {
  id: "config.unset",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("unset")
      .description("Remove one configuration value, reverting the key to its component default.")
      .requiredOption("--project <project_id>", "Project to write.")
      .requiredOption("--env <environment>", `Environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`)
      .requiredOption("--namespace <namespace>", "Component namespace, e.g. meta-capi.")
      .requiredOption("--key <config_key>", "Key within the namespace.")
      .requiredOption("--reason <reason>", "Operator rationale for the audit record.")
      .action(deps.runCommand({ id: "config.unset", mutates: true }, runConfigUnset));
  },
};

export function buildConfigUnsetRunner(hooks: ConfigHooks = {}) {
  const nowFn = hooks.now ?? ((): Date => new Date());
  const generateAuditId = hooks.generateAuditId ?? ((): string => `polaris_aud_${uuidv7()}`);

  return async function runner(args: ConfigUnsetArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const projectId = requireProject(args.project);
    const environment = requireEnvironment(args.env);
    const namespace = requireNamespace(args.namespace);
    const configKey = requireConfigKey(args.key);
    const reason = requireReason(args.reason);

    const store = openStore();
    try {
      const now = nowFn();
      const outcome = await store.unset(
        { projectId, environment, namespace, configKey },
        {
          auditId: generateAuditId(),
          actorSource: ctx.actor.source,
          actorLabel: hooks.actorLabel?.() ?? ctx.actor.label,
          occurredAt: now,
          reason,
        },
      );

      if (outcome.applied) {
        ctx.logger.info(
          {
            audit_id: outcome.auditId,
            audit_action: "config.unset",
            project_id: projectId,
            environment,
            namespace,
            config_key: configKey,
            reason,
            occurred_at: now.toISOString(),
          },
          "project configuration unset (audit row persisted)",
        );
      }

      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: outcome.applied
            ? `unset ${namespace}.${configKey} for ${projectId}/${environment}`
            : `${namespace}.${configKey} was not set for ${projectId}/${environment}`,
          json: {
            applied: outcome.applied,
            audit_id: outcome.auditId,
            namespace,
            config_key: configKey,
          },
        }),
      );
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigUnset = buildConfigUnsetRunner();
