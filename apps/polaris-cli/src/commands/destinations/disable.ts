/**
 * `polaris destinations disable <destination_id> --reason <reason>` — mutating.
 *
 * Transitions a destination's `status` to `'disabled'` and stamps the
 * operator-supplied `--reason` into `disabled_reason`. Idempotent: running
 * on an already-disabled destination prints "already disabled" and exits 0.
 * The original `disabled_reason` is preserved when the row is already
 * disabled — re-running does not overwrite the existing reason.
 *
 * The `--reason` flag is required so the audit record (P6-006) carries a
 * structured rationale, not just a free-text justification field.
 *
 * Audit trail: same contract as `enable`. The audit_records table lands in
 * P6-006; this command logs an audit-intent line and prints a TODO marker
 * to stderr.
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
  disableDestination,
  findDestinationById,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsDisableArgs {
  readonly destinationId: string;
  readonly reason?: string;
}

export interface DestinationsDisableStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  disable(destinationId: string, reason: string, now: Date): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsDisableHooks {
  readonly openStore?: () => DestinationsDisableStore;
  readonly now?: () => Date;
}

export const destinationsDisableCommand: CommandDefinition = {
  id: "destinations.disable",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("disable <destination_id>")
      .description(
        "Disable a destination instance (status='disabled'). Idempotent: re-running on a disabled destination prints `already disabled` and exits 0.",
      )
      .requiredOption(
        "--reason <reason>",
        "Operator rationale for the audit record. Free text, required.",
      );
    cmd.action(async (destinationId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<DestinationsDisableArgs>(
        { id: "destinations.disable", mutates: true },
        runDestinationsDisable,
      );
      const args: DestinationsDisableArgs = {
        destinationId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildDestinationsDisableRunner(hooks: DestinationsDisableHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());

  return async function runner(
    args: DestinationsDisableArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    rejectMappingArguments(args as unknown as Record<string, unknown>);
    const id = args.destinationId.trim();
    if (id.length === 0) {
      throw new UsageError("destination_id is required");
    }
    const reason = args.reason?.trim();
    if (reason === undefined || reason.length === 0) {
      throw new UsageError("--reason is required for audit traceability");
    }
    if (reason.length > 1024) {
      throw new UsageError("--reason must be 1024 characters or fewer");
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`destination "${id}" not found`);
      }
      if (existing.status === "disabled") {
        emit(ctx, {
          destinationId: id,
          applied: false,
          status: "disabled",
          reason: existing.disabled_reason,
        });
        return undefined;
      }

      const now = nowFn();
      const applied = await store.disable(id, reason, now);
      if (!applied) {
        const after = await store.findById(id);
        emit(ctx, {
          destinationId: id,
          applied: false,
          status: after?.status ?? existing.status,
          reason: after?.disabled_reason ?? null,
        });
        return undefined;
      }

      // Audit-intent log line. TODO(P6-006): replace with INSERT into
      // audit_records once the table lands.
      ctx.logger.info(
        {
          audit_action: "destinations.disable",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          previous_status: existing.status,
          new_status: "disabled",
          reason,
          occurred_at: now.toISOString(),
          audit_table_pending: "P6-006",
        },
        "destination disabled (audit-intent log; audit_records table lands in P6-006)",
      );
      ctx.output.writeErr(
        `audit: destination ${id} disabled (audit_records table is created by P6-006; this command must be extended to insert into it after P6-006 lands)`,
      );

      emit(ctx, { destinationId: id, applied: true, status: "disabled", reason });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsDisable = buildDestinationsDisableRunner();

function defaultStore(): DestinationsDisableStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    disable: (id, reason, now) => disableDestination(handle.db, id, reason, now),
    close: () => handle.close(),
  };
}

interface EmitInput {
  readonly destinationId: string;
  readonly applied: boolean;
  readonly status: string;
  readonly reason: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        destination_id: input.destinationId,
        applied: input.applied,
        status: input.status,
        reason: input.reason,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `disabled ${input.destinationId}${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  if (input.status === "disabled") {
    return `${input.destinationId}: already disabled${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  return `${input.destinationId}: ${input.status} (no transition)`;
}
