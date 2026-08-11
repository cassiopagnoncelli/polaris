/**
 * `polaris processors runs show <run_id>` — read-only.
 *
 * Shows one row of `processor_runs`: the process behind a derived event's
 * `processor.run_id`. Rows are written by the processors themselves at boot
 * through `@polaris/shared-processor`'s `openProcessorRun`; this command
 * only reads them.
 *
 * Scope note: this is the RUN, not the processor. Inputs, outputs, mode, and
 * replay support are semantics and live in the manifest — `polaris processors
 * show <name> --version <v>` is the command for those. Earlier drafts of this
 * command declared `git_sha`, `config_hash`, `runtime_settings_hash`,
 * `input_topic`, and `output_topic` on the detail shape; none of those are
 * columns of `processor_runs`, and rendering them would have meant inventing
 * values. The lineage chain in
 * `docs/architecture/05-processors-and-replay.md` reaches them through the
 * processor version, which every run row carries.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, findProcessorRunById } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectProcessorRuleArguments } from "./validation.js";

interface ProcessorsRunsShowArgs {
  readonly runId: string;
}

/**
 * Read-shape rendered by this command — one row of `processor_runs`, no more.
 *
 * `project_id` / `environment` are nullable: a processor consuming the shared
 * stream registers a cross-project run, and a deployment whose environment
 * label is outside the control plane's three environments records unscoped.
 */
export interface ProcessorRunDetail {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly events_consumed: number;
  readonly events_emitted: number;
  readonly events_failed: number;
  readonly host: string | null;
  readonly error_summary: string | null;
}

/** Storage seam. Tests inject an in-memory lookup; production is Kysely. */
export interface ProcessorsRunsShowStore {
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
      .description("Show one processor run. For what the processor does, see `processors show`.");
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
  const handle = connectDb();
  return {
    findById: (runId) => findProcessorRunById(handle.db, runId),
    close: () => handle.close(),
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
    `run_id             ${detail.run_id}`,
    `processor_name     ${detail.processor_name}`,
    `processor_version  ${detail.processor_version}`,
    `project_id         ${detail.project_id ?? "(cross-project)"}`,
    `environment        ${detail.environment ?? "(unscoped)"}`,
    `status             ${detail.status}`,
    `host               ${detail.host ?? "(unknown)"}`,
    `started_at         ${detail.started_at}`,
    `finished_at        ${detail.finished_at ?? "(running)"}`,
    // Running totals, flushed every 15s by the run's heartbeat, so a running
    // row can trail the process by about that long.
    `events_consumed    ${detail.events_consumed}`,
    `events_emitted     ${detail.events_emitted}`,
    `events_failed      ${detail.events_failed}`,
  ];
  if (detail.error_summary !== null) {
    lines.push(`error_summary      ${detail.error_summary}`);
  }
  return lines.join("\n");
}
