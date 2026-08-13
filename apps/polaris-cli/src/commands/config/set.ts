/**
 * `polaris config set --project --env --namespace --key --value [--secret-ref]
 *   --reason` — mutating.
 *
 * The two refusals worth knowing about, both raised by the mutation layer
 * before any write so a rejected call leaves no trace:
 *
 *   - a key that looks like mapping semantics (`field_map`, `event-map`, …).
 *     `project_config.value` is jsonb, so the platform's "PostgreSQL has
 *     nowhere to put a field map" guarantee is no longer structural — this is
 *     what replaces it.
 *   - a plaintext value on a `--secret-ref` key. Secrets are stored as
 *     `<provider>:<ref>` pointers and resolved at read time; a credential
 *     typed here would otherwise land in PostgreSQL, in shell history, and in
 *     the audit row's arguments.
 */

import { PROJECT_CONFIG_SCHEMAS } from "@polaris/project-config-schemas";
import { MappingSemanticsError } from "@polaris/shared-control-plane";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { PlaintextSecretError } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import {
  parseConfigValue,
  requireConfigKey,
  requireEnvironment,
  requireNamespace,
  requireProject,
  requireReason,
  SUPPORTED_ENVIRONMENTS,
} from "./value.js";

interface ConfigSetArgs {
  readonly project?: string;
  readonly env?: string;
  readonly namespace?: string;
  readonly key?: string;
  readonly value?: string;
  readonly secretRef?: boolean;
  readonly reason?: string;
}

export const configSetCommand: CommandDefinition = {
  id: "config.set",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("set")
      .description(
        [
          "Set one configuration value for a project and environment.",
          "Writes the value, bumps the scope version, notifies every replica, and",
          "records an audit row — all in one transaction.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project to write.")
      .requiredOption("--env <environment>", `Environment: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`)
      .requiredOption("--namespace <namespace>", "Component namespace, e.g. meta-capi.")
      .requiredOption("--key <config_key>", "Key within the namespace.")
      .requiredOption(
        "--value <value>",
        "Value. Parsed as JSON when it parses (5000 -> number), else stored as a string.",
      )
      .option(
        "--secret-ref",
        "Mark the value a secret reference (<provider>:<ref>). Plaintext is refused.",
      )
      .requiredOption("--reason <reason>", "Operator rationale for the audit record.")
      .action(deps.runCommand({ id: "config.set", mutates: true }, runConfigSet));
  },
};

export function buildConfigSetRunner(hooks: ConfigHooks = {}) {
  const nowFn = hooks.now ?? ((): Date => new Date());
  const generateAuditId = hooks.generateAuditId ?? ((): string => `polaris_aud_${uuidv7()}`);

  return async function runner(args: ConfigSetArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const projectId = requireProject(args.project);
    const environment = requireEnvironment(args.env);
    const namespace = requireNamespace(args.namespace);
    const configKey = requireConfigKey(args.key);
    const reason = requireReason(args.reason);
    if (args.value === undefined) throw new UsageError("--value is required");

    const isSecretRef = args.secretRef === true;
    // A key the component schema marks secret cannot be written as a plain
    // value: an operator omitting --secret-ref would otherwise store a live
    // credential in PostgreSQL as ordinary jsonb, past every gate that only
    // fires when is_secret_ref is set. Plan §3.5 assigns this check to both
    // write surfaces; the admin panel enforces the same rule from the same
    // generated schema.
    const secretDeclared =
      PROJECT_CONFIG_SCHEMAS[namespace]?.secretKeys.project.includes(configKey) === true;
    if (secretDeclared && !isSecretRef) {
      throw new UsageError(
        `"${configKey}" is a secret-typed key in the "${namespace}" schema; pass --secret-ref ` +
          "with a <provider>:<ref> value. Polaris never stores plaintext secrets.",
      );
    }
    const value = parseConfigValue(args.value, isSecretRef);

    const store = openStore();
    try {
      const now = nowFn();
      const auditId = generateAuditId();
      const outcome = await store.set(
        { projectId, environment, namespace, configKey, value, isSecretRef },
        {
          auditId,
          actorSource: ctx.actor.source,
          actorLabel: hooks.actorLabel?.() ?? ctx.actor.label,
          occurredAt: now,
          reason,
        },
      );

      ctx.logger.info(
        {
          audit_id: outcome.auditId,
          audit_action: "config.set",
          project_id: projectId,
          environment,
          namespace,
          config_key: configKey,
          is_secret_ref: isSecretRef,
          // Never the value: a non-secret value is safe, but branching on
          // is_secret_ref here would be one refactor away from leaking.
          reason,
          occurred_at: now.toISOString(),
        },
        "project configuration set (audit row persisted)",
      );

      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: `set ${namespace}.${configKey} for ${projectId}/${environment}`,
          json: {
            applied: outcome.applied,
            audit_id: outcome.auditId,
            namespace,
            config_key: configKey,
            is_secret_ref: isSecretRef,
          },
        }),
      );
    } catch (err) {
      // Both are operator mistakes, not faults: surface them as usage errors
      // so the CLI exits with the usage code and prints the guidance rather
      // than a stack trace.
      if (err instanceof MappingSemanticsError || err instanceof PlaintextSecretError) {
        throw new UsageError(err.message);
      }
      throw err;
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigSet = buildConfigSetRunner();
