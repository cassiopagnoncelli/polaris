/**
 * `polaris processors show <name> --version <v>` — read-only.
 *
 * Reads the named manifest from
 * `processors/<name>/v<n>/processor.manifest.yaml`, parses it with the Zod
 * schema, and renders the full content plus a table of per-(project, env)
 * activations from `processor_activations`.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";
import {
  type DiscoveredProcessorManifest,
  loadProcessorManifest,
  resolveCatalogRoot,
} from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  connectDb,
  listActivationsForProcessor,
  type ProcessorActivationRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

interface ProcessorsShowArgs {
  readonly name: string;
  readonly version?: string;
  readonly catalogRoot?: string;
}

export interface ProcessorsShowStore {
  listActivations(
    processorName: string,
    processorVersion: string,
  ): Promise<readonly ProcessorActivationRow[]>;
  close(): Promise<void>;
}

export interface ProcessorsShowHooks {
  readonly openStore?: () => ProcessorsShowStore;
  readonly loadManifest?: (
    root: string,
    name: string,
    version: string,
  ) => { ok: true; value: DiscoveredProcessorManifest } | { ok: false; reason: string };
  readonly resolveRoot?: (explicit?: string) => string;
}

export const processorsShowCommand: CommandDefinition = {
  id: "processors.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <name>")
      .description(
        "Show one processor manifest plus the activation rows from processor_activations.",
      )
      .requiredOption("--version <version>", "Processor version directory (e.g. v1, v1.2.3).")
      .option(
        "--catalog-root <path>",
        "Override the repository root (defaults to walking up from cwd / POLARIS_CATALOG_ROOT).",
      );
    cmd.action(
      async (name: string, opts: { version?: string; catalogRoot?: string }, command: Command) => {
        const wrapped = deps.runCommand<ProcessorsShowArgs>(
          { id: "processors.show", mutates: false },
          runProcessorsShow,
        );
        const args: ProcessorsShowArgs = {
          name,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.catalogRoot !== undefined ? { catalogRoot: opts.catalogRoot } : {}),
        };
        await wrapped(args, command);
      },
    );
  },
};

export function buildProcessorsShowRunner(hooks: ProcessorsShowHooks = {}) {
  const loadManifest =
    hooks.loadManifest ?? ((root, name, version) => loadProcessorManifest({ root, name, version }));
  const resolveRoot =
    hooks.resolveRoot ??
    ((explicit?: string) => resolveCatalogRoot(explicit !== undefined ? { explicit } : {}));

  return async function runner(args: ProcessorsShowArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    // Defense-in-depth: reject any rule-shaped flag even though commander
    // only declares --version / --catalog-root.
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const name = args.name.trim();
    if (name.length === 0) {
      throw new UsageError("processor name is required");
    }
    const version = trim(args.version);
    if (version === undefined) {
      throw new UsageError("--version is required (e.g. v1, v1.2.3)");
    }

    const explicitRoot = trim(args.catalogRoot);
    const root = resolveRoot(explicitRoot);

    const result = loadManifest(root, name, version);
    if (!result.ok) {
      throw new UsageError(`processor "${name}" version "${version}": ${result.reason}`);
    }

    const store = openStore();
    let activations: readonly ProcessorActivationRow[];
    try {
      activations = await store.listActivations(name, version);
    } finally {
      await store.close();
    }

    emit(ctx, result.value, activations);
    return undefined;
  };
}

const runProcessorsShow = buildProcessorsShowRunner();

function defaultStore(env: NodeJS.ProcessEnv): ProcessorsShowStore {
  const handle = connectDb({ env });
  return {
    listActivations: (name, version) => listActivationsForProcessor(handle.db, name, version),
    close: () => handle.close(),
  };
}

function emit(
  ctx: CommandContext,
  discovered: DiscoveredProcessorManifest,
  activations: readonly ProcessorActivationRow[],
): void {
  const manifest = discovered.manifest;
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(discovered, activations),
      json: {
        path: discovered.path,
        manifest,
        activations: activations.map((row) => ({
          project_id: row.project_id,
          environment: row.environment,
          enabled_state: row.enabled_state,
          enabled_at: row.enabled_at,
          disabled_at: row.disabled_at,
          last_changed_by: row.last_changed_by,
        })),
      },
    }),
  );
}

function renderHuman(
  discovered: DiscoveredProcessorManifest,
  activations: readonly ProcessorActivationRow[],
): string {
  const manifest = discovered.manifest;
  const inputs = manifest.inputs
    .map((spec) => `${spec.family} (schema_versions=${formatSchemaVersions(spec.schema_versions)})`)
    .join("\n                       ");
  const outputs = manifest.outputs
    .map((spec) => `${spec.family} (schema_versions=${formatSchemaVersions(spec.schema_versions)})`)
    .join("\n                       ");
  const lines = [
    `name                   ${manifest.name}`,
    `version                ${manifest.version}`,
    `owner                  ${manifest.owner}`,
    `mode                   ${manifest.mode}`,
    `manifest_path          ${discovered.path}`,
    `inputs                 ${inputs}`,
    `outputs                ${outputs}`,
    `state_stores           ${manifest.state_stores.length === 0 ? "(none)" : manifest.state_stores.join(", ")}`,
  ];
  if (manifest.defaults !== undefined) {
    lines.push(
      `defaults.consumer_group           ${manifest.defaults.consumer_group ?? "(unset)"}`,
    );
    if (manifest.defaults.partitions_consumed_concurrently !== undefined) {
      lines.push(
        `defaults.partitions_consumed_concurrently ${manifest.defaults.partitions_consumed_concurrently}`,
      );
    }
  }
  if (manifest.replay !== undefined) {
    lines.push(`replay.supported       ${String(manifest.replay.supported)}`);
    if (manifest.replay.restrictions.length > 0) {
      lines.push(`replay.restrictions    ${manifest.replay.restrictions.join(", ")}`);
    }
  }
  lines.push(`description            ${manifest.description}`);
  lines.push("");
  lines.push(`activations (count=${activations.length}):`);
  if (activations.length === 0) {
    lines.push("  (no rows in processor_activations for this (name, version))");
  } else {
    for (const row of activations) {
      lines.push(
        `  project=${row.project_id} env=${row.environment} state=${row.enabled_state} ` +
          `enabled_at=${row.enabled_at ?? "null"} disabled_at=${row.disabled_at ?? "null"} ` +
          `last_changed_by=${row.last_changed_by}`,
      );
    }
  }
  return lines.join("\n");
}

function formatSchemaVersions(spec: "*" | readonly number[]): string {
  if (spec === "*") return "*";
  return `[${spec.join(", ")}]`;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
