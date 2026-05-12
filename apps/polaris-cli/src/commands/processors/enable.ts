/**
 * `polaris processors enable <name> --version <v> --project <id> --env <env>`
 * — mutating.
 *
 * Upserts the row in `processor_activations` for the
 * `(processor_name, processor_version, project_id, environment)` tuple to
 * `enabled_state = 'enabled'`. The runner first verifies the manifest exists
 * on disk so operators get a clear error when they typo the version.
 *
 * Idempotent: running on an already-enabled tuple prints "already enabled"
 * and exits 0; the audit-intent log line is suppressed on the no-op path.
 *
 * Audit trail: this command MUST emit an audit record. The audit table is
 * created by P6-006 and is not yet merged. For P6-005, the CLI logs a
 * structured INFO line describing the transition AND prints a stderr TODO
 * marker so operators (and the future P6-006 task) know the audit-table
 * write is pending. The structured-log line carries the canonical audit
 * fields so the post-P6-006 change is a one-line persistence shim.
 *
 * TODO(P6-006): replace the `logger.info(...)` audit-intent line with an
 * actual INSERT into the audit_records table inside the same transaction
 * as the activation upsert.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import type { Environment } from "@polaris/shared-db";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { loadProcessorManifest, resolveCatalogRoot } from "../../catalog/index.js";
import {
  type EnableProcessorActivationInput,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
  connectDb,
  enableProcessorActivation,
  findActivationByKey,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

const SUPPORTED_ENVIRONMENTS: readonly Environment[] = [
  "development",
  "staging",
  "production",
] as const;

interface ProcessorsEnableArgs {
  readonly name: string;
  readonly version?: string;
  readonly project?: string;
  readonly env?: string;
  readonly catalogRoot?: string;
}

export interface ProcessorsEnableStore {
  findByKey(key: ProcessorActivationKey): Promise<ProcessorActivationRow | null>;
  enable(input: EnableProcessorActivationInput): Promise<boolean>;
  close(): Promise<void>;
}

export interface ProcessorsEnableHooks {
  readonly openStore?: () => ProcessorsEnableStore;
  readonly now?: () => Date;
  readonly verifyManifest?: (root: string, name: string, version: string) => boolean;
  readonly resolveRoot?: (explicit?: string) => string;
  readonly actorLabel?: () => string;
}

export const processorsEnableCommand: CommandDefinition = {
  id: "processors.enable",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("enable <name>")
      .description("Enable a processor for one (project, environment) scope. Idempotent.")
      .requiredOption("--version <version>", "Processor version directory (e.g. v1, v1.2.3).")
      .requiredOption("--project <project_id>", "Project to activate this processor for.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .option(
        "--catalog-root <path>",
        "Override the repository root (defaults to walking up from cwd).",
      );
    cmd.action(
      async (
        name: string,
        opts: { version?: string; project?: string; env?: string; catalogRoot?: string },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<ProcessorsEnableArgs>(
          { id: "processors.enable", mutates: true },
          runProcessorsEnable,
        );
        const args: ProcessorsEnableArgs = {
          name,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.project !== undefined ? { project: opts.project } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.catalogRoot !== undefined ? { catalogRoot: opts.catalogRoot } : {}),
        };
        await wrapped(args, command);
      },
    );
  },
};

export function buildProcessorsEnableRunner(hooks: ProcessorsEnableHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const verifyManifest =
    hooks.verifyManifest ??
    ((root, name, version) => loadProcessorManifest({ root, name, version }).ok);
  const resolveRoot =
    hooks.resolveRoot ??
    ((explicit?: string) => resolveCatalogRoot(explicit !== undefined ? { explicit } : {}));
  const actorLabel = hooks.actorLabel ?? (() => "cli");

  return async function runner(
    args: ProcessorsEnableArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    // Defense-in-depth: reject any flag that resembles a transform-rule
    // surface. Commander declares only --version / --project / --env /
    // --catalog-root, but the runtime gate fires even if a programmatic
    // caller smuggles a rule-shaped key through.
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const key = validate(args);
    const explicitRoot = trim(args.catalogRoot);
    const root = resolveRoot(explicitRoot);
    if (!verifyManifest(root, key.processor_name, key.processor_version)) {
      throw new UsageError(
        `manifest not found for processor "${key.processor_name}" version "${key.processor_version}" under ${root}/processors/`,
      );
    }

    const store = openStore();
    try {
      const existing = await store.findByKey(key);
      if (existing !== null && existing.enabled_state === "enabled") {
        emit(ctx, { ...key, applied: false, enabled_state: "enabled" });
        return undefined;
      }

      const now = nowFn();
      const applied = await store.enable({
        ...key,
        enabledAt: now,
        lastChangedBy: actorLabel(),
      });
      if (!applied) {
        // The find/enable race-condition path: another writer landed between
        // our find and our upsert. Re-fetch and surface whatever the DB
        // ended up with.
        const after = await store.findByKey(key);
        emit(ctx, {
          ...key,
          applied: false,
          enabled_state: after?.enabled_state ?? "enabled",
        });
        return undefined;
      }

      // Audit-intent log line. TODO(P6-006): once audit_records exists,
      // replace this with an INSERT inside the same transaction as the
      // activation upsert.
      ctx.logger.info(
        {
          audit_action: "processors.enable",
          processor_name: key.processor_name,
          processor_version: key.processor_version,
          project_id: key.project_id,
          environment: key.environment,
          previous_state: existing?.enabled_state ?? "(no row)",
          new_state: "enabled",
          occurred_at: now.toISOString(),
          audit_table_pending: "P6-006",
        },
        "processor enabled (audit-intent log; audit_records table lands in P6-006)",
      );
      ctx.output.writeErr(
        `audit: processor ${key.processor_name} ${key.processor_version} enabled for project=${key.project_id} env=${key.environment} (audit_records table is created by P6-006; this command must be extended to insert into it after P6-006 lands)`,
      );

      emit(ctx, { ...key, applied: true, enabled_state: "enabled" });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsEnable = buildProcessorsEnableRunner();

function defaultStore(): ProcessorsEnableStore {
  const handle = connectDb({ env: process.env });
  return {
    findByKey: (key) => findActivationByKey(handle.db, key),
    enable: (input) => enableProcessorActivation(handle.db, input),
    close: () => handle.close(),
  };
}

function validate(args: ProcessorsEnableArgs): ProcessorActivationKey {
  const name = args.name.trim();
  if (name.length === 0) {
    throw new UsageError("processor name is required");
  }
  const version = trim(args.version);
  if (version === undefined) {
    throw new UsageError("--version is required (e.g. v1, v1.2.3)");
  }
  if (!/^v[0-9]+(\.[0-9]+){0,2}$/.test(version)) {
    throw new UsageError(
      `--version "${version}" is invalid. Expected a tag like v1, v2, or v1.2.3.`,
    );
  }
  const projectId = trim(args.project);
  if (projectId === undefined) {
    throw new UsageError("--project is required");
  }
  const env = trim(args.env);
  if (env === undefined) {
    throw new UsageError("--env is required");
  }
  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  return {
    processor_name: name,
    processor_version: version,
    project_id: projectId,
    environment: env,
  };
}

interface EmitInput extends ProcessorActivationKey {
  readonly applied: boolean;
  readonly enabled_state: "enabled" | "disabled";
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        project_id: input.project_id,
        environment: input.environment,
        applied: input.applied,
        enabled_state: input.enabled_state,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `enabled ${input.processor_name} ${input.processor_version} for project=${input.project_id} env=${input.environment}`;
  }
  return `${input.processor_name} ${input.processor_version} project=${input.project_id} env=${input.environment}: already ${input.enabled_state}`;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
