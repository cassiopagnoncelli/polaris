/**
 * `polaris destinations show <destination_id>` — read-only.
 *
 * Renders the full destination row including operational tuning fields and
 * the provider-namespaced `secret_ref`. The CLI never resolves the secret
 * value; it only displays the reference string.
 *
 * Returns exit code 2 (usage) when the id is unknown.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, type DestinationRow, findDestinationById } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsShowArgs {
  readonly destinationId: string;
}

export interface DestinationsShowStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  close(): Promise<void>;
}

export interface DestinationsShowHooks {
  readonly openStore?: () => DestinationsShowStore;
}

export const destinationsShowCommand: CommandDefinition = {
  id: "destinations.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <destination_id>")
      .description("Show one destination instance's runtime state and operational tuning.");
    cmd.action(async (destinationId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<DestinationsShowArgs>(
        { id: "destinations.show", mutates: false },
        runDestinationsShow,
      );
      await wrapped({ destinationId }, command);
    });
  },
};

export function buildDestinationsShowRunner(hooks: DestinationsShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(
    args: DestinationsShowArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectMappingArguments(args as unknown as Record<string, unknown>);
    const id = args.destinationId.trim();
    if (id.length === 0) {
      throw new UsageError("destination_id is required");
    }

    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`destination "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsShow = buildDestinationsShowRunner();

function defaultStore(): DestinationsShowStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: DestinationRow): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: { destination: row },
    }),
  );
}

function renderHuman(row: DestinationRow): string {
  const lines = [
    `destination_id        ${row.destination_id}`,
    `project_id            ${row.project_id}`,
    `environment           ${row.environment}`,
    `vendor                ${row.vendor}`,
    `instance_label        ${row.instance_label}`,
    `secret_ref            ${row.secret_ref}`,
    `status                ${row.status}`,
    `mode                  ${row.mode}`,
    `max_concurrency       ${row.max_concurrency}`,
    `max_rps               ${row.max_rps}`,
    `retry_policy          ${row.retry_policy}`,
    `dead_letter_threshold ${row.dead_letter_threshold}`,
    `replay_opt_in         ${row.replay_opt_in}`,
    `created_at            ${row.created_at}`,
    `updated_at            ${row.updated_at}`,
  ];
  if (row.disabled_reason !== null) {
    lines.push(`disabled_reason       ${row.disabled_reason}`);
  }
  if (row.replay_opt_in_reason !== null) {
    lines.push(`replay_opt_in_reason  ${row.replay_opt_in_reason}`);
  }
  if (row.replay_opt_in_at !== null) {
    lines.push(`replay_opt_in_at      ${row.replay_opt_in_at}`);
  }
  return lines.join("\n");
}
