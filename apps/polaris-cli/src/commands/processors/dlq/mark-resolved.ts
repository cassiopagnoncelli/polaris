/**
 * `polaris processors dlq mark-resolved <dlq_id> [--note <text>]`
 * — mutating.
 *
 * Marks one processor DLQ record resolved without re-republishing
 * the message to the source topic. Use this when the underlying
 * event has been hand-fixed elsewhere (e.g. a backfill ran) and
 * the operator just wants the queue entry off the active-triage
 * list.
 *
 * Idempotent: re-running on an already-resolved row returns
 * `applied: false` with the original resolver / note preserved.
 *
 * `mutates: true`: routes through the P6-007 production gate.
 */

import {
  createKyselyProcessorDlqRecordRepository,
  type MarkResolvedOutcome,
} from "@polaris/shared-processor";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../../command.js";
import { connectDb } from "../../../db/index.js";
import { UsageError } from "../../../errors.js";
import { renderAccordingTo } from "../../../output.js";

interface MarkResolvedArgs {
  readonly dlqId: string;
  readonly note?: string;
}

export interface ProcessorDlqMarkResolvedStore {
  markResolved(
    dlq_id: string,
    resolvedBy: string,
    note: string | null,
  ): Promise<MarkResolvedOutcome>;
  close(): Promise<void>;
}

export interface ProcessorDlqMarkResolvedHooks {
  readonly openStore?: () => ProcessorDlqMarkResolvedStore;
}

export const processorsDlqMarkResolvedCommand: CommandDefinition = {
  id: "processors.dlq.mark-resolved",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("mark-resolved <dlq_id>")
      .description("Mark one processor DLQ record resolved without re-publishing.")
      .option("--note <text>", "Operator-supplied resolution note (<=1024 chars).")
      .action(async (dlqId: string, opts: { note?: string }, command: Command) => {
        const wrapped = deps.runCommand<MarkResolvedArgs>(
          { id: "processors.dlq.mark-resolved", mutates: true },
          runProcessorsDlqMarkResolved,
        );
        const args: MarkResolvedArgs = {
          dlqId,
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        };
        await wrapped(args, command);
      });
  },
};

export function buildProcessorsDlqMarkResolvedRunner(hooks: ProcessorDlqMarkResolvedHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  return async function runner(args: MarkResolvedArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.dlqId.trim();
    if (id.length === 0) throw new UsageError("dlq_id is required");
    const note = args.note?.trim();
    if (note !== undefined && note.length > 1024) {
      throw new UsageError("--note must be 1024 chars or fewer");
    }

    const store = openStore();
    try {
      const outcome = await store.markResolved(id, ctx.actor.label, note ?? null);
      ctx.output.writeOut(
        renderAccordingTo(ctx.config.output, {
          human: outcome.applied
            ? `marked ${id} resolved.\n`
            : `${id} was already resolved (no-op).\n`,
          json: {
            applied: outcome.applied,
            dlq_id: outcome.record.dlq_id,
            resolved_at: outcome.record.resolved_at?.toISOString() ?? null,
            resolved_by: outcome.record.resolved_by,
            resolution_note: outcome.record.resolution_note,
          },
        }),
      );
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runProcessorsDlqMarkResolved = buildProcessorsDlqMarkResolvedRunner();

function defaultStore(): ProcessorDlqMarkResolvedStore {
  const handle = connectDb({ env: process.env });
  const repo = createKyselyProcessorDlqRecordRepository({ db: handle.db });
  return {
    markResolved: (id, by, note) => repo.markResolved(id, by, note),
    close: () => handle.close(),
  };
}
