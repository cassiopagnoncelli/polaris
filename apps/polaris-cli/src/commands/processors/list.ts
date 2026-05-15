/**
 * `polaris processors list` — read-only.
 *
 * Scans `processors/*\/v*\/processor.manifest.yaml` from the workspace root
 * and surfaces, per manifest:
 *
 *   - name, version (from the manifest)
 *   - mode, owner (from the manifest)
 *   - inputs / outputs (topic-family list from the manifest)
 *   - activation rows from PostgreSQL (one per (project, environment) pair)
 *
 * Defensive behavior: if a manifest is malformed (invalid YAML, missing
 * fields, schema violation), the loader appends a warning to stderr and
 * skips that row. One bad manifest does not crash the command.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import {
  type DiscoveredProcessorManifest,
  loadProcessorManifests,
  type ProcessorManifest,
  type ProcessorManifestScan,
  type ProcessorManifestWarning,
  resolveCatalogRoot,
} from "../../catalog/index.js";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, listAllActivations, type ProcessorActivationRow } from "../../db/index.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

interface ProcessorsListArgs {
  readonly catalogRoot?: string;
}

export interface ProcessorsListStore {
  listActivations(): Promise<readonly ProcessorActivationRow[]>;
  close(): Promise<void>;
}

export interface ProcessorsListHooks {
  readonly openStore?: () => ProcessorsListStore;
  readonly loadManifests?: (root: string) => ProcessorManifestScan;
  readonly resolveRoot?: (explicit?: string) => string;
}

export const processorsListCommand: CommandDefinition = {
  id: "processors.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description(
        "List versioned processor manifests on disk and their per-(project, env) activation rows.",
      )
      .option(
        "--catalog-root <path>",
        "Override the repository root (defaults to walking up from cwd / POLARIS_CATALOG_ROOT).",
      )
      .action(deps.runCommand({ id: "processors.list", mutates: false }, runProcessorsList));
  },
};

export function buildProcessorsListRunner(hooks: ProcessorsListHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const loadManifests = hooks.loadManifests ?? ((root) => loadProcessorManifests({ root }));
  const resolveRoot =
    hooks.resolveRoot ??
    ((explicit?: string) => resolveCatalogRoot(explicit !== undefined ? { explicit } : {}));

  return async function runner(args: ProcessorsListArgs, ctx: CommandContext): Promise<undefined> {
    // Defense-in-depth: reject any flag that resembles a transform-rule
    // surface even though commander only declares --catalog-root above.
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const explicitRoot = trim(args.catalogRoot);
    const root = resolveRoot(explicitRoot);
    const scan = loadManifests(root);
    emitWarnings(ctx, scan.warnings);

    const store = openStore();
    let activations: readonly ProcessorActivationRow[];
    try {
      activations = await store.listActivations();
    } finally {
      await store.close();
    }

    emit(ctx, scan.manifests, activations);
    return undefined;
  };
}

const runProcessorsList = buildProcessorsListRunner();

function defaultStore(): ProcessorsListStore {
  const handle = connectDb({ env: process.env });
  return {
    listActivations: () => listAllActivations(handle.db),
    close: () => handle.close(),
  };
}

interface ProcessorListView {
  readonly name: string;
  readonly version: string;
  readonly mode: ProcessorManifest["mode"];
  readonly owner: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly activations: readonly ProcessorListActivationView[];
}

interface ProcessorListActivationView {
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: "enabled" | "disabled";
  readonly enabled_at: string | null;
  readonly disabled_at: string | null;
  readonly last_changed_by: string;
}

function buildView(
  discovered: DiscoveredProcessorManifest,
  activations: readonly ProcessorActivationRow[],
): ProcessorListView {
  const matching = activations
    .filter(
      (row) =>
        row.processor_name === discovered.manifest.name &&
        row.processor_version === discovered.manifest.version,
    )
    .map<ProcessorListActivationView>((row) => ({
      project_id: row.project_id,
      environment: row.environment,
      enabled_state: row.enabled_state,
      enabled_at: row.enabled_at,
      disabled_at: row.disabled_at,
      last_changed_by: row.last_changed_by,
    }));
  return {
    name: discovered.manifest.name,
    version: discovered.manifest.version,
    mode: discovered.manifest.mode,
    owner: discovered.manifest.owner,
    inputs: discovered.manifest.inputs.map((spec) => spec.family),
    outputs: discovered.manifest.outputs.map((spec) => spec.family),
    activations: matching,
  };
}

function emitWarnings(ctx: CommandContext, warnings: readonly ProcessorManifestWarning[]): void {
  for (const warning of warnings) {
    ctx.output.writeErr(
      `warning: skipping malformed processor manifest at ${warning.path} (${warning.reason})`,
    );
  }
}

function emit(
  ctx: CommandContext,
  manifests: readonly DiscoveredProcessorManifest[],
  activations: readonly ProcessorActivationRow[],
): void {
  const view = manifests.map((m) => buildView(m, activations));
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(view),
      json: { count: view.length, processors: view },
    }),
  );
}

function renderHuman(view: readonly ProcessorListView[]): string {
  if (view.length === 0) {
    return "(no processor manifests discovered under processors/<name>/v<n>/processor.manifest.yaml)";
  }
  const lines: string[] = [`count=${view.length}`];
  for (const proc of view) {
    lines.push(
      `  ${proc.name} ${proc.version} mode=${proc.mode} owner=${proc.owner} inputs=[${proc.inputs.join(", ")}] outputs=[${proc.outputs.join(", ")}]`,
    );
    if (proc.activations.length === 0) {
      lines.push("    (no activation rows in processor_activations)");
    } else {
      for (const act of proc.activations) {
        lines.push(
          `    project=${act.project_id} env=${act.environment} state=${act.enabled_state} last_changed_by=${act.last_changed_by}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
