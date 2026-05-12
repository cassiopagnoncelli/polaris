/**
 * `polaris processors runs show <run_id>` — read-only.
 *
 * Surfaces one processor-run record when the `processor_runs` table
 * exists. See the long-form comment on `runs-list.ts` for the wiring
 * contract — the same shape applies here:
 *
 *   1. Args validated.
 *   2. `rejectProcessorRuleArguments` gate fires.
 *   3. Store `probe()` decides between "not yet provisioned" and a real
 *      `findById(run_id)` lookup.
 *   4. The default store stub returns the P8-001 "not yet provisioned"
 *      message and exit 0.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

interface ProcessorsRunsShowArgs {
  readonly runId: string;
}

/**
 * Future-facing read-shape. Mirrors `runs-list.ts`'s
 * `ProcessorRunListRow` plus the metric / lineage payload the architecture
 * doc spells out in
 * `docs/architecture/05-processors-and-replay.md "Processor Metadata"`.
 */
export interface ProcessorRunDetail {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly git_sha: string;
  readonly config_hash: string;
  readonly runtime_settings_hash: string;
  readonly input_topic: string;
  readonly output_topic: string;
  readonly project_id: string;
  readonly environment: string;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly metrics: Readonly<Record<string, number | string>>;
}

export interface ProcessorsRunsShowStore {
  probe(): Promise<null | { pendingTask: string; message: string }>;
  findById(runId: string): Promise<ProcessorRunDetail | null>;
  close(): Promise<void>;
}

export interface ProcessorsRunsShowHooks {
  readonly openStore?: () => ProcessorsRunsShowStore;
}

export const processorsRunsShowCommand: CommandDefinition = {
  id: "processors.runs.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <run_id>")
      .description(
        "Show one processor run. Surfaces 'not yet provisioned' until P8-001 lands processor_runs.",
      );
    cmd.action(async (runId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<ProcessorsRunsShowArgs>(
        { id: "processors.runs.show", mutates: false },
        runProcessorsRunsShow,
      );
      await wrapped({ runId }, command);
    });
  },
};

export function buildProcessorsRunsShowRunner(hooks: ProcessorsRunsShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(
    args: ProcessorsRunsShowArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectProcessorRuleArguments(args as unknown as Record<string, unknown>);

    const runId = args.runId.trim();
    if (runId.length === 0) {
      throw new UsageError("run_id is required");
    }

    const store = openStore();
    try {
      const probe = await store.probe();
      if (probe !== null) {
        ctx.output.writeErr(probe.message);
        ctx.output.writeOut(
          renderAccordingTo(ctx.config.output, {
            human: probe.message,
            json: {
              not_provisioned: true,
              pending_task: probe.pendingTask,
              message: probe.message,
              run: null,
            },
          }),
        );
        return undefined;
      }

      const detail = await store.findById(runId);
      if (detail === null) {
        throw new UsageError(`processor run "${runId}" not found`);
      }
      emit(ctx, detail);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsRunsShow = buildProcessorsRunsShowRunner();

function defaultStore(): ProcessorsRunsShowStore {
  return {
    probe: async () => ({
      pendingTask: "P8-001",
      message:
        "processor_runs table not yet provisioned — wired in P8-001 (Processor Runtime Helpers).",
    }),
    findById: async () => {
      throw new UsageError(
        "processor_runs lookup is not implemented in P6-005 — P8-001 must replace defaultStore() with a Kysely-backed findById.",
      );
    },
    close: async () => {},
  };
}

function emit(ctx: CommandContext, detail: ProcessorRunDetail): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(detail),
      json: { run: detail },
    }),
  );
}

function renderHuman(detail: ProcessorRunDetail): string {
  const lines = [
    `run_id                 ${detail.run_id}`,
    `processor_name         ${detail.processor_name}`,
    `processor_version      ${detail.processor_version}`,
    `git_sha                ${detail.git_sha}`,
    `config_hash            ${detail.config_hash}`,
    `runtime_settings_hash  ${detail.runtime_settings_hash}`,
    `input_topic            ${detail.input_topic}`,
    `output_topic           ${detail.output_topic}`,
    `project_id             ${detail.project_id}`,
    `environment            ${detail.environment}`,
    `status                 ${detail.status}`,
    `started_at             ${detail.started_at}`,
    `finished_at            ${detail.finished_at ?? "(running)"}`,
  ];
  const metricKeys = Object.keys(detail.metrics).sort();
  if (metricKeys.length > 0) {
    lines.push("metrics:");
    for (const key of metricKeys) {
      lines.push(`  ${key}=${detail.metrics[key]}`);
    }
  }
  return lines.join("\n");
}
