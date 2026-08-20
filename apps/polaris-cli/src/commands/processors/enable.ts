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
 * and exits 0; no audit row is written on the no-op path.
 *
 * Audit trail: when the transition lands, this command INSERTs a row into
 * `audit_records` inside the SAME transaction as the activation upsert.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */

import type { Environment } from "@polaris/persistence-postgres";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import { loadProcessorManifest, resolveCatalogRoot } from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type EnableProcessorActivationInput,
  enableProcessorActivationWithAudit,
  findActivationByKey,
  type ProcessorActivationKey,
  type ProcessorActivationRow,
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

/**
 * Snapshot of the operational columns the audit row stores. The
 * activation row holds only runtime/operational data; transform rules
 * live in versioned code, never here.
 */
export interface ProcessorAuditSnapshot {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: "enabled" | "disabled" | "(no row)";
  readonly enabled_at: string | null;
  readonly disabled_at: string | null;
  readonly last_changed_by: string;
}

export interface ProcessorsEnableAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: ProcessorAuditSnapshot;
  readonly after: ProcessorAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

export interface ProcessorsEnableStore {
  findByKey(key: ProcessorActivationKey): Promise<ProcessorActivationRow | null>;
  /**
   * Upsert the activation row to `enabled` AND persist the audit row in
   * the SAME transaction.
   */
  enableWithAudit(
    input: EnableProcessorActivationInput,
    audit: ProcessorsEnableAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface ProcessorsEnableHooks {
  readonly openStore?: () => ProcessorsEnableStore;
  readonly now?: () => Date;
  readonly verifyManifest?: (root: string, name: string, version: string) => boolean;
  readonly resolveRoot?: (explicit?: string) => string;
  readonly actorLabel?: () => string;
  readonly generateAuditId?: () => string;
}

export const processorsEnableCommand: CommandDefinition = {
  id: "processors.enable",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("enable <name>")
      .description(
        "Enable a processor for one (project, environment) scope, undoing a " +
          "disable. Processors with no row already run. Idempotent.",
      )
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
  const nowFn = hooks.now ?? (() => new Date());
  const verifyManifest =
    hooks.verifyManifest ??
    ((root, name, version) => loadProcessorManifest({ root, name, version }).ok);
  const actorLabelOverride = hooks.actorLabel;
  const generateAuditId = hooks.generateAuditId ?? uuidv7;

  return async function runner(
    args: ProcessorsEnableArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const resolveRoot =
      hooks.resolveRoot ??
      ((explicit?: string) =>
        resolveCatalogRoot({ env: ctx.env, ...(explicit !== undefined ? { explicit } : {}) }));
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const key = validate(args);
    const explicitRoot = trim(args.catalogRoot);
    const root = resolveRoot(explicitRoot);
    if (!verifyManifest(root, key.processor_name, key.processor_version)) {
      throw new UsageError(
        `manifest not found for processor "${key.processor_name}" version "${key.processor_version}" under ${root}/{sync,async}/<stage>/<name>/<version>/`,
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
      const auditId = generateAuditId();
      const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;
      const before: ProcessorAuditSnapshot =
        existing === null
          ? {
              processor_name: key.processor_name,
              processor_version: key.processor_version,
              project_id: key.project_id,
              environment: key.environment,
              enabled_state: "(no row)",
              enabled_at: null,
              disabled_at: null,
              last_changed_by: "(none)",
            }
          : {
              processor_name: existing.processor_name,
              processor_version: existing.processor_version,
              project_id: existing.project_id,
              environment: existing.environment,
              enabled_state: existing.enabled_state,
              enabled_at: existing.enabled_at,
              disabled_at: existing.disabled_at,
              last_changed_by: existing.last_changed_by,
            };
      const after: ProcessorAuditSnapshot = {
        ...before,
        enabled_state: "enabled",
        enabled_at: now.toISOString(),
        last_changed_by: actorLabel,
      };
      const auditPayload: ProcessorsEnableAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel,
        occurredAt: now,
        before,
        after,
        projectId: key.project_id,
        environment: key.environment as AuditEnvironment,
      };

      const applied = await store.enableWithAudit(
        {
          ...key,
          enabledAt: now,
          lastChangedBy: actorLabel,
        },
        auditPayload,
      );
      if (!applied) {
        const afterRow = await store.findByKey(key);
        emit(ctx, {
          ...key,
          applied: false,
          enabled_state: afterRow?.enabled_state ?? "enabled",
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "processors.enable",
          processor_name: key.processor_name,
          processor_version: key.processor_version,
          project_id: key.project_id,
          environment: key.environment,
          previous_state: existing?.enabled_state ?? "(no row)",
          new_state: "enabled",
          occurred_at: now.toISOString(),
        },
        "processor enabled (audit row persisted)",
      );

      emit(ctx, { ...key, applied: true, enabled_state: "enabled" });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsEnable = buildProcessorsEnableRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProcessorsEnableStore {
  const handle = connectDb({ env });
  return {
    findByKey: (key) => findActivationByKey(handle.db, key),
    enableWithAudit: async (input, audit) => {
      const existing = await findActivationByKey(handle.db, input);
      const outcome = await enableProcessorActivationWithAudit(
        handle.db,
        { key: input, existing, changedBy: input.lastChangedBy },
        {
          auditId: audit.auditId,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          occurredAt: audit.occurredAt,
          before: audit.before,
          after: audit.after,
        },
      );
      return outcome.applied;
    },
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
