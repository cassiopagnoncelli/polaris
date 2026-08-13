/**
 * `polaris config validate --env <env> [--project] [--component]`
 * — read-only.
 *
 * The pre-deploy gate. Plan §11 makes each service's cutover big-bang — the
 * environment path is deleted in the same commit the config path lands — which
 * is only safe if a missing value fails the ROLLOUT rather than the running
 * fleet. This is what fails the rollout.
 *
 * It runs against the target environment's own database, which is why it
 * cannot be a CI check: a PR pipeline has no access to production's
 * `project_config`. CI verifies what lives in the repo (schema drift and the
 * additive-only rule); this verifies what lives in the environment about to be
 * deployed to.
 *
 * What counts as a failure is deliberately narrow: a key the component
 * declares REQUIRED, with no stored value and no schema default. An unset
 * optional key is healthy — it means "use the component default", which is
 * exactly what the migrated environment variables meant. Reporting those as
 * problems would make the gate noisy enough to be waved through, which is the
 * only way a deploy gate actually fails.
 *
 * Free-form keys are reported as warnings and never fail: a project may
 * declare variables no component in this repo reads (plan §3.1), and a
 * client-owned consumer under multi-tenancy has no schema here at all.
 *
 * NOT here: plan §11's opt-in `--resolve`, which would dereference secret
 * references against the live provider. The CLI has no secret-provider
 * wiring yet, and a flag that accepted the argument while checking nothing
 * would tell an operator their credentials were verified when they were
 * not — the same failure `topics isolate` refuses rather than commits. It
 * lands with the consumer cutovers, when the CLI gains a resolver.
 *
 * @see docs/implementation/project-config-plan.md §11
 */

import { PROJECT_CONFIG_SCHEMAS } from "@polaris/project-config-schemas";
import type { CommandContext, CommandDefinition } from "../../command.js";
import type { AuditEnvironment, ProjectConfigRow } from "../../db/index.js";
import { CliError, ExitCode } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { type ConfigHooks, type ConfigStore, defaultConfigStore } from "./store.js";
import { requireEnvironment, SUPPORTED_ENVIRONMENTS } from "./value.js";

/** A required key with nothing to satisfy it. */
export interface MissingKey {
  readonly projectId: string;
  readonly namespace: string;
  readonly configKey: string;
}

/** A stored key no component schema declares. Informational, never fatal. */
export interface UnknownKey {
  readonly projectId: string;
  readonly namespace: string;
  readonly configKey: string;
}

export interface ValidationReport {
  readonly environment: string;
  readonly projectsChecked: number;
  readonly missing: readonly MissingKey[];
  readonly unknown: readonly UnknownKey[];
}

/**
 * Compare one project's stored rows against every component schema.
 *
 * Pure, so the interesting logic is testable without a database — which
 * matters because the registry currently declares no required keys, and this
 * gate's whole purpose is what happens when one exists.
 */
export function validateProject(
  projectId: string,
  rows: readonly ProjectConfigRow[],
  schemas: typeof PROJECT_CONFIG_SCHEMAS = PROJECT_CONFIG_SCHEMAS,
  componentFilter?: string,
): { missing: MissingKey[]; unknown: UnknownKey[] } {
  const missing: MissingKey[] = [];
  const unknown: UnknownKey[] = [];
  const stored = new Set(rows.map((row) => `${row.namespace}\0${row.config_key}`));
  const declared = new Set<string>();

  for (const [namespace, entry] of Object.entries(schemas)) {
    if (componentFilter !== undefined && namespace !== componentFilter) continue;
    const schema = entry.project as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema["required"] ?? []) as string[]);

    for (const [key, property] of Object.entries(properties)) {
      declared.add(`${namespace}\0${key}`);
      if (!required.has(key)) continue;
      // A schema default satisfies a required key: the component will start
      // and behave predictably, which is what the gate is protecting.
      if (property["default"] !== undefined) continue;
      if (stored.has(`${namespace}\0${key}`)) continue;
      missing.push({ projectId, namespace, configKey: key });
    }
  }

  for (const row of rows) {
    if (componentFilter !== undefined && row.namespace !== componentFilter) continue;
    if (declared.has(`${row.namespace}\0${row.config_key}`)) continue;
    unknown.push({ projectId, namespace: row.namespace, configKey: row.config_key });
  }

  return { missing, unknown };
}

interface ConfigValidateArgs {
  readonly env?: string;
  readonly project?: string;
  readonly component?: string;
}

export const configValidateCommand: CommandDefinition = {
  id: "config.validate",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("validate")
      .description(
        [
          "Check that every required configuration key has a value in an environment.",
          "Run as a pre-deploy gate against the environment being deployed to —",
          "CI cannot do this, having no access to that environment's database.",
        ].join("\n"),
      )
      .requiredOption(
        "--env <environment>",
        `Environment to check: ${SUPPORTED_ENVIRONMENTS.join(" | ")}.`,
      )
      .option("--project <project_id>", "Check one project instead of all of them.")
      .option("--component <namespace>", "Check one component's namespace.")
      .action(deps.runCommand({ id: "config.validate", mutates: false }, runConfigValidate));
  },
};

export function buildConfigValidateRunner(hooks: ConfigHooks = {}) {
  return async function runner(args: ConfigValidateArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? ((): ConfigStore => defaultConfigStore(ctx.env));
    const environment = requireEnvironment(args.env);
    const component = args.component?.trim();

    const store = openStore();
    try {
      const projectIds =
        args.project !== undefined && args.project.trim().length > 0
          ? [args.project.trim()]
          : await store.listProjectIds();

      const missing: MissingKey[] = [];
      const unknown: UnknownKey[] = [];

      for (const projectId of projectIds) {
        const rows = await store.list({ projectId, environment: environment as AuditEnvironment });
        const result = validateProject(
          projectId,
          rows,
          PROJECT_CONFIG_SCHEMAS,
          component !== undefined && component.length > 0 ? component : undefined,
        );
        missing.push(...result.missing);
        unknown.push(...result.unknown);
      }

      const report: ValidationReport = {
        environment,
        projectsChecked: projectIds.length,
        missing,
        unknown,
      };

      emit(ctx, report);
      // Exit non-zero ONLY on missing required keys. Unknown keys are a
      // warning: failing on them would block a deploy over a variable the
      // platform was designed to let projects declare. The report is printed
      // BEFORE throwing, so the deploy log carries the list, not just a code.
      if (missing.length > 0) {
        throw new CliError(
          `${String(missing.length)} required configuration key(s) missing in ${environment}`,
          { exitCode: ExitCode.GenericFailure },
        );
      }
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runConfigValidate = buildConfigValidateRunner();

function emit(ctx: CommandContext, report: ValidationReport): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(report),
      json: {
        environment: report.environment,
        projects_checked: report.projectsChecked,
        missing: report.missing.map((entry) => ({
          project_id: entry.projectId,
          namespace: entry.namespace,
          config_key: entry.configKey,
        })),
        unknown: report.unknown.map((entry) => ({
          project_id: entry.projectId,
          namespace: entry.namespace,
          config_key: entry.configKey,
        })),
      },
    }),
  );
}

function renderHuman(report: ValidationReport): string {
  const lines: string[] = [];
  if (report.missing.length > 0) {
    lines.push(`MISSING required configuration in ${report.environment}:`);
    for (const entry of report.missing) {
      lines.push(`  ${entry.projectId}  ${entry.namespace}.${entry.configKey}`);
    }
    lines.push("");
    lines.push("Set each with `polaris config set --namespace <ns> --key <key> --value <v>`.");
  }
  if (report.unknown.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Stored keys no component schema declares (not a failure):");
    for (const entry of report.unknown) {
      lines.push(`  ${entry.projectId}  ${entry.namespace}.${entry.configKey}`);
    }
  }
  if (lines.length === 0) {
    return `${report.environment}: every required key has a value across ${String(report.projectsChecked)} project(s).`;
  }
  return lines.join("\n");
}
