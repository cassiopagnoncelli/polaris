/**
 * `polaris config invalidate --project --env --reason` — mutating.
 *
 * Bumps the scope's version and notifies every replica without changing a
 * single value.
 *
 * This exists for the one case version-watching structurally cannot see. When
 * an operator rotates a credential inside Vault, `project_config` does not
 * change — the reference is the same string — so the version never moves, no
 * notification fires, and every replica keeps serving the plaintext it
 * resolved earlier until the 5-minute secret deadline expires. This command
 * forces that drop immediately, which is what an operator revoking a leaked
 * credential actually needs.
 */

import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import {
  requireEnvironment,
  requireProject,
  requireReason,
  SUPPORTED_ENVIRONMENTS,
} from "./value.js";

interface ConfigInvalidateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly reason?: string;
}

export const configInvalidateCommand: CommandDefinition = {
  id: "config.invalidate",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("invalidate")
      .description(
        [
          "Force every replica to drop its cached configuration for a scope.",
          "Changes no values. Use after rotating a credential inside the secret",
          "provider, where the stored reference is unchanged and nothing else",
          "would signal the fleet.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project scope.")
      .requiredOption("--env <environment>", `Environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`)
      .requiredOption("--reason <reason>", "Operator rationale for the audit record.")
      .action(deps.runCommand({ id: "config.invalidate", mutates: true }, runConfigInvalidate));
  },
};

export function buildConfigInvalidateRunner(hooks: ConfigHooks = {}) {
  const nowFn = hooks.now ?? ((): Date => new Date());
  const generateAuditId = hooks.generateAuditId ?? ((): string => `polaris_aud_${uuidv7()}`);

  return async function runner(
    args: ConfigInvalidateArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const projectId = requireProject(args.project);
    const environment = requireEnvironment(args.env);
    const reason = requireReason(args.reason);

    const store = openStore();
    try {
      const now = nowFn();
      const outcome = await store.invalidate(
        { projectId, environment },
        {
          auditId: generateAuditId(),
          actorSource: ctx.actor.source,
          actorLabel: hooks.actorLabel?.() ?? ctx.actor.label,
          occurredAt: now,
          reason,
        },
      );

      ctx.logger.info(
        {
          audit_id: outcome.auditId,
          audit_action: "config.invalidate",
          project_id: projectId,
          environment,
          reason,
          occurred_at: now.toISOString(),
        },
        "project configuration invalidated (audit row persisted)",
      );

      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: `invalidated cached configuration for ${projectId}/${environment}`,
          json: { applied: outcome.applied, audit_id: outcome.auditId },
        }),
      );
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigInvalidate = buildConfigInvalidateRunner();
