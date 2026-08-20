/**
 * `polaris config set --project --env --namespace --key --value [--secret]
 *   --reason` — mutating.
 *
 * The refusal worth knowing about is raised by the mutation layer before any
 * write, so a rejected call leaves no trace: a key that looks like mapping
 * semantics (`field_map`, `event-map`, …). `project_config.value` is jsonb, so
 * the platform's "PostgreSQL has nowhere to put a field map" guarantee is no
 * longer structural — that check is what replaces it.
 *
 * `--secret` marks a value sensitive. It does not change where the value is
 * stored — every value lives in `project_config` either way — it changes how
 * the value is handled once stored: masked in `config get` / `config list`,
 * `[redacted]` in the audit row, boxed in `Secret<T>` when a consumer reads it.
 *
 * Note the value still passes through this process's argv, so it lands in
 * shell history. `polaris config set` is the scripting surface; the admin UI's
 * Variables panel is the one to reach for when typing a credential by hand.
 */

import { PROJECT_CONFIG_SCHEMAS } from "@polaris/tenancy-config-schemas";
import { MappingSemanticsError } from "@polaris/tenancy-control-plane";
import {
  FILTER_OPERATORS,
  FILTERABLE_ROOTS,
  parseRoutingGateConfig,
  ROUTING_GATE_CONFIG_KEY,
} from "@polaris/delivery-destinations";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { MaskedSecretWriteError } from "../../db/index.js";
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
  readonly secret?: boolean;
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
        "--secret",
        "Mark the value sensitive: masked in reads and exports, [redacted] in the audit row.",
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

    // The generated schema decides, and the flag can only ADD sensitivity —
    // never remove it. A key its component declares secret is stored secret
    // whether or not the operator remembered `--secret`; the flag exists for
    // free-form keys, which no schema knows about and which are exactly the
    // ones an operator invents under time pressure.
    //
    // Deciding here rather than refusing here is the change from the
    // reference era, when omitting the flag meant a credential was about to be
    // stored in a column that promised to hold pointers. There is no such
    // column now, so a forgotten flag is a handling mistake to correct, not an
    // unsafe write to reject. The admin panel forces the same bit from the
    // same schema.
    const secretDeclared =
      PROJECT_CONFIG_SCHEMAS[namespace]?.secretKeys.project.includes(configKey) === true;
    const isSecret = secretDeclared || args.secret === true;
    const value = parseConfigValue(args.value, isSecret);

    // The routing gate degrades to "unconfigured" on a value it cannot
    // parse, which is the right behaviour at DELIVERY time — a typo must not
    // mute a destination — but it makes a typo invisible at WRITE time: the
    // set succeeds, the operator believes the gate is on, and every event
    // keeps flowing. Refusing here is where the mistake is still cheap and
    // still attached to the person who made it.
    if (configKey === ROUTING_GATE_CONFIG_KEY && parseRoutingGateConfig(value) === undefined) {
      throw new UsageError(
        `"${ROUTING_GATE_CONFIG_KEY}" is not a valid routing gate configuration. ` +
          "Expected an object with optional `subscriptions` " +
          "({ events?: string[], prefixes?: string[] }), `filters` " +
          `([{ path, op, value? }] where path starts with one of ${FILTERABLE_ROOTS.join(", ")} ` +
          `and op is one of ${FILTER_OPERATORS.join(", ")}), and \`requireConsent\` ` +
          "(a list of consent dimensions).",
      );
    }

    const store = openStore();
    try {
      const now = nowFn();
      const auditId = generateAuditId();
      const outcome = await store.set(
        { projectId, environment, namespace, configKey, value, isSecret },
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
          is_secret: isSecret,
          // Never the value: a non-secret value is safe, but branching on
          // is_secret here would be one refactor away from leaking.
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
            is_secret: isSecret,
          },
        }),
      );
    } catch (err) {
      // Both are operator mistakes, not faults: surface them as usage errors
      // so the CLI exits with the usage code and prints the guidance rather
      // than a stack trace.
      if (err instanceof MappingSemanticsError || err instanceof MaskedSecretWriteError) {
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
