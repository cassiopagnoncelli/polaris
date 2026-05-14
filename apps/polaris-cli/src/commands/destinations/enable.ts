/**
 * `polaris destinations enable <destination_id>` — mutating.
 *
 * Transitions a destination's `status` to `'active'` and clears
 * `disabled_reason`. Idempotent: running on an already-active destination
 * prints "already active" and exits 0.
 *
 * Audit trail: when the transition lands, this command INSERTs a row into
 * `audit_records` inside the SAME transaction as the status UPDATE. The
 * `before` snapshot is the row state pre-UPDATE; the `after` snapshot is
 * the row state post-UPDATE. Neither contains a resolved secret value —
 * the destination row stores `secret_ref` only.
 *
 * The structured INFO log line stays because operators may still want a
 * local trail, but the persisted audit row is the source of truth.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  type DestinationRow,
  connectDb,
  enableDestination,
  findDestinationById,
  insertAuditRecord,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsEnableArgs {
  readonly destinationId: string;
}

/**
 * Snapshot the runner places into `audit_records.before` / `after`. The
 * shape is the operational columns of the destination row, never anything
 * secret-resolved. The persisted JSON is exactly what is shown to
 * operators by `audit show`. Operational tuning columns are included so
 * `destinations.create` and `destinations.update-ops` audit rows carry a
 * complete picture of the row state — for `enable` and `disable` those
 * columns are unchanged but the snapshot is still self-contained.
 */
export interface DestinationAuditSnapshot {
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
}

export interface DestinationsEnableAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: DestinationAuditSnapshot;
  readonly after: DestinationAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

export interface DestinationsEnableStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  /**
   * Transition the row to `active` AND persist an audit row in the SAME
   * transaction. Returns `true` when both writes landed (a real
   * transition); `false` when the UPDATE updated zero rows (another
   * caller transitioned the row first).
   */
  enableWithAudit(
    destinationId: string,
    now: Date,
    audit: DestinationsEnableAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsEnableHooks {
  readonly openStore?: () => DestinationsEnableStore;
  readonly now?: () => Date;
  /** Test override for the audit_id generator. Defaults to `uuidv7`. */
  readonly generateAuditId?: () => string;
  /** Test override for the actor-label resolver. Defaults to `'cli'`. */
  readonly actorLabel?: () => string;
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
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

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
      const auditId = generateAuditId();
      const auditPayload: DestinationsEnableAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before: toSnapshot(existing),
        after: toSnapshot({
          ...existing,
          status: "active",
          disabled_reason: null,
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
      };

      const applied = await store.enableWithAudit(id, now, auditPayload);
      if (!applied) {
        const after = await store.findById(id);
        emit(ctx, {
          destinationId: id,
          applied: false,
          status: after?.status ?? existing.status,
        });
        return undefined;
      }

      // Structured INFO log stays for local operator trail. The
      // persisted `audit_records` row is now the source of truth — the
      // log line is convenience only.
      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "destinations.enable",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          previous_status: existing.status,
          new_status: "active",
          occurred_at: now.toISOString(),
        },
        "destination enabled (audit row persisted)",
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
    enableWithAudit: async (id, now, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await enableDestination(trx, id, now);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "destinations.enable",
          target_type: "destination",
          target_id: id,
          project_id: audit.projectId,
          environment: audit.environment,
          before: audit.before,
          after: audit.after,
          reason: null,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
        return true;
      }),
    close: () => handle.close(),
  };
}

function toSnapshot(row: DestinationRow): DestinationAuditSnapshot {
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
