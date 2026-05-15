/**
 * `polaris destinations enable-replay <destination_id> --reason <text>` — mutating.
 *
 * P7-004 introduces a per-instance replay opt-in column on the
 * `destinations` table (`replay_opt_in`). This command flips that column
 * to `true` and stamps the operator-supplied reason + opt-in timestamp,
 * recording the rationale in `audit_records` inside the SAME transaction
 * as the row UPDATE.
 *
 * The destination runtime
 * (`packages/shared-destinations/src/replay-suppression.ts`) consults
 * this column on every replayed message. Until an operator flips it on,
 * the destination's replay messages are suppressed: a structured INFO
 * log line lands, `polaris_destination_replay_suppressed_total`
 * increments, and the message is dropped before normalize/map/deliver
 * runs. There is no delivery record on suppression — the metric and the
 * audit history together form the audit trail.
 *
 * Audit trail: when the transition lands, this command INSERTs a row
 * into `audit_records` with `action='destinations.enable-replay'` and
 * the operator's reason. The `before` snapshot captures
 * `replay_opt_in=false` plus the previous (possibly stale) reason; the
 * `after` snapshot captures `replay_opt_in=true` and the new reason
 * along with `replay_opt_in_at`. Neither carries a resolved secret
 * value.
 *
 * Idempotent: re-running on an already-opted-in destination prints
 * `already opted in` and exits 0. The original `replay_opt_in_at` and
 * `replay_opt_in_reason` are preserved on the idempotent path so the
 * audit history shows the canonical opt-in moment, not a repeat
 * acknowledgement.
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
  connectDb,
  type DestinationRow,
  enableDestinationReplay,
  findDestinationById,
  insertAuditRecord,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsEnableReplayArgs {
  readonly destinationId: string;
  readonly reason?: string;
}

/**
 * Snapshot recorded into `audit_records.before` / `audit_records.after`
 * for the enable-replay transition. P7-004's snapshot mirrors P6-006's
 * destination-enable/disable snapshot but carries the replay-specific
 * columns so an audit reviewer sees exactly what flipped.
 *
 * Operational tuning columns are included so the snapshot is
 * self-contained: a future audit reviewer can read one record and
 * understand the row state without joining against `destinations`.
 */
export interface DestinationReplayAuditSnapshot {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly secret_ref: string;
  readonly status: string;
  readonly mode: string;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: string;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly replay_opt_in: boolean;
  readonly replay_opt_in_reason: string | null;
  readonly replay_opt_in_at: string | null;
}

export interface DestinationsEnableReplayAuditPayload {
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

export interface DestinationsEnableReplayStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  /**
   * Flip `replay_opt_in` to `true`, stamp the operator-supplied reason
   * and opt-in timestamp, and persist an audit row in the SAME
   * transaction. Returns `true` when both writes landed (a real
   * transition); `false` when the UPDATE updated zero rows (another
   * caller already flipped the column).
   */
  enableReplayWithAudit(
    destinationId: string,
    reason: string,
    now: Date,
    audit: DestinationsEnableReplayAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsEnableReplayHooks {
  readonly openStore?: () => DestinationsEnableReplayStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const destinationsEnableReplayCommand: CommandDefinition = {
  id: "destinations.enable-replay",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("enable-replay <destination_id>")
      .description(
        [
          "Enable replay delivery for one destination instance (P7-004).",
          "",
          "Flips `replay_opt_in` to TRUE on the destination row. The runtime",
          "consults this column on every replayed message; until you flip it on,",
          "replay traffic against this destination is suppressed (a structured",
          "log line + a `polaris_destination_replay_suppressed_total` metric",
          "are written; no vendor delivery happens).",
          "",
          "Idempotent: re-running on an already-opted-in destination prints",
          "`already opted in` and exits 0. The original reason and opt-in",
          "timestamp are preserved on the idempotent path.",
        ].join("\n"),
      )
      .requiredOption(
        "--reason <reason>",
        "Operator rationale for the audit record. Free text, required.",
      );
    cmd.action(async (destinationId: string, opts: { reason?: string }, command: Command) => {
      const wrapped = deps.runCommand<DestinationsEnableReplayArgs>(
        { id: "destinations.enable-replay", mutates: true },
        runDestinationsEnableReplay,
      );
      const args: DestinationsEnableReplayArgs = {
        destinationId,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      await wrapped(args, command);
    });
  },
};

export function buildDestinationsEnableReplayRunner(hooks: DestinationsEnableReplayHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(
    args: DestinationsEnableReplayArgs,
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
      if (existing.replay_opt_in === true) {
        emit(ctx, {
          destinationId: id,
          applied: false,
          replayOptIn: true,
          reason: existing.replay_opt_in_reason,
          optedInAt: existing.replay_opt_in_at,
        });
        return undefined;
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const auditPayload: DestinationsEnableReplayAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before: toSnapshot(existing),
        after: toSnapshot({
          ...existing,
          replay_opt_in: true,
          replay_opt_in_reason: reason,
          replay_opt_in_at: now.toISOString(),
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason,
      };

      const applied = await store.enableReplayWithAudit(id, reason, now, auditPayload);
      if (!applied) {
        const after = await store.findById(id);
        emit(ctx, {
          destinationId: id,
          applied: false,
          replayOptIn: after?.replay_opt_in ?? existing.replay_opt_in,
          reason: after?.replay_opt_in_reason ?? null,
          optedInAt: after?.replay_opt_in_at ?? null,
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "destinations.enable-replay",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          previous_replay_opt_in: existing.replay_opt_in,
          new_replay_opt_in: true,
          reason,
          occurred_at: now.toISOString(),
        },
        "destination replay opt-in enabled (audit row persisted)",
      );

      emit(ctx, {
        destinationId: id,
        applied: true,
        replayOptIn: true,
        reason,
        optedInAt: now.toISOString(),
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsEnableReplay = buildDestinationsEnableReplayRunner();

function defaultStore(): DestinationsEnableReplayStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    enableReplayWithAudit: async (id, reason, now, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await enableDestinationReplay(trx, id, reason, now);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "destinations.enable-replay",
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
  readonly optedInAt: string | null;
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
        replay_opt_in_at: input.optedInAt,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (input.applied) {
    return `replay opt-in enabled for ${input.destinationId}${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  if (input.replayOptIn) {
    return `${input.destinationId}: already opted in${
      input.reason !== null ? ` (reason: ${input.reason})` : ""
    }`;
  }
  return `${input.destinationId}: replay opt-in unchanged (replay_opt_in=${input.replayOptIn})`;
}
