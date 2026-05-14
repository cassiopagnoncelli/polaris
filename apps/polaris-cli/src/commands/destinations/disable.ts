/**
 * `polaris destinations disable <destination_id> --reason <reason>` — mutating.
 *
 * Transitions a destination's `status` to `'disabled'` and stamps the
 * operator-supplied `--reason` into `disabled_reason`. Idempotent: running
 * on an already-disabled destination prints "already disabled" and exits 0.
 * The original `disabled_reason` is preserved when the row is already
 * disabled — re-running does not overwrite the existing reason.
 *
 * The `--reason` flag is required so the audit record carries a structured
 * rationale, not just a free-text justification field.
 *
 * Audit trail: when the transition lands, this command INSERTs a row into
 * `audit_records` inside the SAME transaction as the status UPDATE. The
 * `reason` operator-supplied value is stored on the audit row. Neither
 * `before` nor `after` carry a resolved secret value.
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
  disableDestination,
  findDestinationById,
  insertAuditRecord,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationAuditSnapshot } from "./enable.js";
import { rejectMappingArguments } from "./validation.js";

interface DestinationsDisableArgs {
  readonly destinationId: string;
  readonly reason?: string;
}

export interface DestinationsDisableAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: DestinationAuditSnapshot;
  readonly after: DestinationAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

export interface DestinationsDisableStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  disableWithAudit(
    destinationId: string,
    reason: string,
    now: Date,
    audit: DestinationsDisableAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsDisableHooks {
  readonly openStore?: () => DestinationsDisableStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
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
  const generateAuditId = hooks.generateAuditId ?? uuidv7;
  const actorLabelOverride = hooks.actorLabel;

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
      const auditId = generateAuditId();
      const auditPayload: DestinationsDisableAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before: toSnapshot(existing),
        after: toSnapshot({
          ...existing,
          status: "disabled",
          disabled_reason: reason,
        }),
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason,
      };

      const applied = await store.disableWithAudit(id, reason, now, auditPayload);
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

      ctx.logger.info(
        {
          audit_id: auditId,
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
        },
        "destination disabled (audit row persisted)",
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
    disableWithAudit: async (id, reason, now, audit) =>
      handle.db.transaction().execute(async (trx) => {
        const applied = await disableDestination(trx, id, reason, now);
        if (!applied) return false;
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "destinations.disable",
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
