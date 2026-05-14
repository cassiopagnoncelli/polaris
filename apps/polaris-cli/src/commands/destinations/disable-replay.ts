/**
 * `polaris destinations disable-replay <destination_id> --reason <text>` — mutating.
 *
 * P7-004 introduces a per-instance replay opt-in column on the
 * `destinations` table (`replay_opt_in`). This command flips that column
 * BACK to `false` and stamps the operator-supplied reason on
 * `replay_opt_in_reason`. The `replay_opt_in_at` column is intentionally
 * NOT cleared — operators may want to see the most recent time replay
 * was active even after the column has been flipped off. The boolean is
 * the authoritative gate.
 *
 * Audit trail: when the transition lands, this command INSERTs a row
 * into `audit_records` with `action='destinations.disable-replay'` and
 * the operator's reason. The `before` snapshot captures
 * `replay_opt_in=true` and the previous reason; the `after` snapshot
 * captures `replay_opt_in=false` and the new reason. Neither carries a
 * resolved secret value.
 *
 * Idempotent: re-running on an already-disabled destination prints
 * `already opted out` and exits 0. The original reason is preserved on
 * the idempotent path so the audit history shows the canonical
 * disable-replay moment, not a repeat acknowledgement.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/architecture/06-destinations.md "Delivery Model"
 * @see docs/implementation/tasks/P7-004-destination-replay-guardrails.md
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  type DestinationRow,
  connectDb,
  disableDestinationReplay,
  findDestinationById,
  insertAuditRecord,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationReplayAuditSnapshot } from "./enable-replay.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsDisableReplayArgs {
  readonly destinationId: string;
  readonly reason?: string;
}

export interface DestinationsDisableReplayAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: DestinationReplayAuditSnapshot;
  readonly after: DestinationReplayAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

export interface DestinationsDisableReplayStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  /**
   * Flip `replay_opt_in` back to `false`, stamp the operator-supplied
   * reason, and persist an audit row in the SAME transaction. Returns
   * `true` when both writes landed (a real transition); `false` when the
   * UPDATE updated zero rows (another caller already flipped the column).
   */
  disableReplayWithAudit(
    destinationId: string,
    reason: string,
    now: Date,
    audit: DestinationsDisableReplayAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsDisableReplayHooks {
  readonly openStore?: () => DestinationsDisableReplayStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const destinationsDisableReplayCommand: CommandDefinition = {
  id: "destinations.disable-replay",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("disable-replay <destination_id>")
      .description(
        [
          "Disable replay delivery for one destination instance (P7-004).",
          "",
          "Flips `replay_opt_in` back to FALSE on the destination row. The runtime",
          "consults this column on every replayed message; once it is FALSE, replay",
          "traffic against this destination is suppressed.",
          "",
          "Idempotent: re-running on an already-disabled destination prints",
          "`already opted out` and exits 0. The previous reason is preserved.",
        ].join("\n"),
      )
      .requiredOption(
        "--reason <reason>",
        "Operator rationale for the audit record. Free text, required.",
      );
    cmd.action(async (destinationId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<DestinationsDisableReplayArgs>(
        { id: "destinations.disable-replay", mutates: true },
        runDestinationsDisableReplay,
      );
      const args: DestinationsDisableReplayArgs = {
        destinationId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildDestinationsDisableReplayRunner(hooks: DestinationsDisableReplayHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(
    args: DestinationsDisableReplayArgs,
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
      if (existing.replay_opt_in === false) {
        emit(ctx, {
          destinationId: id,
          applied: false,
          replayOptIn: false,
          reason: existing.replay_opt_in_reason,
        });
        return undefined;
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const auditPayload: DestinationsDisableReplayAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before: toSnapshot(existing),
        after: toSnapshot({
          ...existing,
          replay_opt_in: false,
          replay_opt_in_reason: reason,
          // replay_opt_in_at is NOT cleared — preserve the most recent
          // opt-in time so operators can see when replay was last active.
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason,
      };

      const applied = await store.disableReplayWithAudit(id, reason, now, auditPayload);
      if (!applied) {
        const after = await store.findById(id);
        emit(ctx, {
          destinationId: id,
          applied: false,
          replayOptIn: after?.replay_opt_in ?? existing.replay_opt_in,
          reason: after?.replay_opt_in_reason ?? null,
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "destinations.disable-replay",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          previous_replay_opt_in: existing.replay_opt_in,
          new_replay_opt_in: false,
          reason,
          occurred_at: now.toISOString(),
        },
        "destination replay opt-in disabled (audit row persisted)",
      );

      emit(ctx, {
        destinationId: id,
        applied: true,
        replayOptIn: false,
        reason,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsDisableReplay = buildDestinationsDisableReplayRunner();

function defaultStore(): DestinationsDisableReplayStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    disableReplayWithAudit: async (id, reason, now, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await disableDestinationReplay(trx, id, reason, now);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "destinations.disable-replay",
          target_type: "destination",
          target_id: id,
          project_id: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: audit.reason,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
        return true;
      }),
    close: () => handle.close(),
  };
}

function toSnapshot(row: DestinationRow): DestinationReplayAuditSnapshot {
  return {
    destination_id: row.destination_id,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    instance_label: row.instance_label,
    secret_ref: row.secret_ref,
    status: row.status,
    mode: row.mode,
    max_concurrency: row.max_concurrency,
    max_rps: row.max_rps,
    retry_policy: row.retry_policy,
    dead_letter_threshold: row.dead_letter_threshold,
    disabled_reason: row.disabled_reason,
    replay_opt_in: row.replay_opt_in,
    replay_opt_in_reason: row.replay_opt_in_reason,
    replay_opt_in_at: row.replay_opt_in_at,
  };
}

interface EmitInput {
  readonly destinationId: string;
  readonly applied: boolean;
  readonly replayOptIn: boolean;
  readonly reason: string | null;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        destination_id: input.destinationId,
        applied: input.applied,
        replay_opt_in: input.replayOptIn,
        reason: input.reason,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `replay opt-in disabled for ${input.destinationId}${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  if (!input.replayOptIn) {
    return `${input.destinationId}: already opted out${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  return `${input.destinationId}: replay opt-in unchanged`;
}
