/**
 * `polaris destinations enable <destination_id>` — mutating.
 *
 * Transitions a destination's `status` to `'active'` and clears
 * `disabled_reason`. Idempotent: running on an already-active destination
 * prints "already active" and exits 0.
 *
 * Audit trail: this command MUST emit an audit record. The audit table is
 * created by P6-006 (audit-export CLI) and is not yet merged. For P6-004,
 * the CLI logs a structured INFO line describing the transition AND prints
 * a stderr TODO marker so operators (and the future P6-006 task) know the
 * audit-table write is pending. The structured-log line carries the
 * canonical audit fields so the post-P6-006 change is a one-line
 * persistence shim.
 *
 * TODO(P6-006): replace the `logger.info(...)` audit-intent line with an
 * actual INSERT into the audit_records table inside the same transaction
 * as the status UPDATE.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type DestinationRow,
  connectDb,
  enableDestination,
  findDestinationById,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsEnableArgs {
  readonly destinationId: string;
}

export interface DestinationsEnableStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  enable(destinationId: string, now: Date): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsEnableHooks {
  readonly openStore?: () => DestinationsEnableStore;
  readonly now?: () => Date;
}

export const destinationsEnableCommand: CommandDefinition = {
  id: "destinations.enable",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("enable <destination_id>")
      .description(
        "Enable a destination instance (status='active'). Idempotent: re-running on an active destination prints `already active` and exits 0.",
      );
    cmd.action(async (destinationId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<DestinationsEnableArgs>(
        { id: "destinations.enable", mutates: true },
        runDestinationsEnable,
      );
      await wrapped({ destinationId }, command);
    });
  },
};

export function buildDestinationsEnableRunner(hooks: DestinationsEnableHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());

  return async function runner(
    args: DestinationsEnableArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectMappingArguments(args as unknown as Record<string, unknown>);
    const id = args.destinationId.trim();
    if (id.length === 0) {
      throw new UsageError("destination_id is required");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`destination "${id}" not found`);
      }
      if (existing.status === "active") {
        emit(ctx, { destinationId: id, applied: false, status: "active" });
        return undefined;
      }

      const now = nowFn();
      const applied = await store.enable(id, now);
      if (!applied) {
        const after = await store.findById(id);
        emit(ctx, {
          destinationId: id,
          applied: false,
          status: after?.status ?? existing.status,
        });
        return undefined;
      }

      // Audit-intent log line. TODO(P6-006): once audit_records exists,
      // replace this with an INSERT inside the same transaction as the
      // status UPDATE.
      ctx.logger.info(
        {
          audit_action: "destinations.enable",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          previous_status: existing.status,
          new_status: "active",
          occurred_at: now.toISOString(),
          audit_table_pending: "P6-006",
        },
        "destination enabled (audit-intent log; audit_records table lands in P6-006)",
      );
      ctx.output.writeErr(
        `audit: destination ${id} enabled (audit_records table is created by P6-006; this command must be extended to insert into it after P6-006 lands)`,
      );

      emit(ctx, { destinationId: id, applied: true, status: "active" });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsEnable = buildDestinationsEnableRunner();

function defaultStore(): DestinationsEnableStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    enable: (id, now) => enableDestination(handle.db, id, now),
    close: () => handle.close(),
  };
}

interface EmitInput {
  readonly destinationId: string;
  readonly applied: boolean;
  readonly status: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        destination_id: input.destinationId,
        applied: input.applied,
        status: input.status,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `enabled ${input.destinationId}`;
  }
  return `${input.destinationId}: already ${input.status}`;
}
