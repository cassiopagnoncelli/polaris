/**
 * `polaris destinations rotate-secret <destination_id> --secret-value <credential>
 *   --reason <reason>` — mutating.
 *
 * Replaces a destination's stored vendor credential.
 *
 * This command exists because the credential IS the stored value. While
 * `destinations` held a `<provider>:<ref>` pointer, rotating meant replacing
 * the secret behind the pointer in Vault and Polaris had nothing to do — the
 * row never changed, and there was deliberately no CLI verb for it. With the
 * value in the row, the alternatives to this command would be recreating the
 * destination (a new `destination_id`, breaking replay pins and delivery
 * history) or direct SQL (no audit row).
 *
 * Not idempotent in the sense `enable` / `disable` are: this command cannot
 * report "already set to that" without reading the old credential back into
 * the process to compare, which is exactly the read this codebase confines to
 * the delivery path. Re-running is a harmless no-op write that bumps
 * `updated_at` and records a second audit row.
 *
 * Audit trail: an `audit_records` row lands in the SAME transaction as the
 * UPDATE, with matching `before` and `after` snapshots — the one field that
 * changed is the one field the audit log may not hold. `--reason` is required
 * and is what carries the meaning: "leaked in a support ticket", "quarterly
 * rotation", "vendor revoked the old token".
 *
 * The credential reaches this process through argv, so it lands in shell
 * history. For a rotation prompted by a leak, prefer the admin UI's form; if
 * you use this command, clear the history entry afterwards.
 *
 * `mutates: true`. P6-007 gates this against production-without-token.
 */
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type DestinationRow,
  findDestinationById,
  rotateDestinationSecretWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationAuditSnapshot } from "./enable.js";
import { rejectMappingArguments, validateSecretValue } from "./validation.js";

interface DestinationsRotateSecretArgs {
  readonly destinationId: string;
  readonly secretValue?: string;
  readonly reason?: string;
}

export interface DestinationsRotateSecretAuditPayload {
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

export interface DestinationsRotateSecretStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  rotateWithAudit(
    destinationId: string,
    secretValue: string,
    now: Date,
    audit: DestinationsRotateSecretAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsRotateSecretHooks {
  readonly openStore?: () => DestinationsRotateSecretStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const destinationsRotateSecretCommand: CommandDefinition = {
  id: "destinations.rotate-secret",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("rotate-secret <destination_id>")
      .description(
        "Replace a destination's vendor credential. The new value is stored as given and never printed back.",
      )
      .requiredOption(
        "--secret-value <credential>",
        "The new vendor credential. Shape is the consumer's — meta-capi wants " +
          '{"pixel_id":"…","access_token":"…"} JSON.',
      )
      .requiredOption(
        "--reason <reason>",
        "Operator rationale for the audit record. Free text, required.",
      );
    cmd.action(
      async (
        destinationId: string,
        opts: { secretValue?: string; reason?: string },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<DestinationsRotateSecretArgs>(
          { id: "destinations.rotate-secret", mutates: true },
          runDestinationsRotateSecret,
        );
        const args: DestinationsRotateSecretArgs = {
          destinationId,
          ...(opts.secretValue !== undefined ? { secretValue: opts.secretValue } : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        };
        await wrapped(args, command);
      },
    );
  },
};

export function buildDestinationsRotateSecretRunner(hooks: DestinationsRotateSecretHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(
    args: DestinationsRotateSecretArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    rejectMappingArguments(args as unknown as Record<string, unknown>);
    const id = args.destinationId.trim();
    if (id.length === 0) {
      throw new UsageError("destination_id is required");
    }
    if (args.secretValue === undefined) {
      throw new UsageError("--secret-value is required");
    }
    const secretValue = validateSecretValue(args.secretValue);
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

      const now = nowFn();
      const auditId = generateAuditId();
      const snapshot = toSnapshot(existing);
      const auditPayload: DestinationsRotateSecretAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before: snapshot,
        after: snapshot,
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason,
      };

      const applied = await store.rotateWithAudit(id, secretValue, now, auditPayload);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "destinations.rotate-secret",
          destination_id: id,
          project_id: existing.project_id,
          environment: existing.environment,
          vendor: existing.vendor,
          instance_label: existing.instance_label,
          // No credential field, old or new. The point of the command is the
          // one thing this line may not carry.
          reason,
          occurred_at: now.toISOString(),
        },
        "destination credential rotated (audit row persisted)",
      );

      emit(ctx, { destinationId: id, applied });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsRotateSecret = buildDestinationsRotateSecretRunner();

function defaultStore(env: NodeJS.ProcessEnv): DestinationsRotateSecretStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    rotateWithAudit: async (id, secretValue, now, audit) => {
      const row = await findDestinationById(handle.db, id);
      if (row === null) return false;
      const outcome = await rotateDestinationSecretWithAudit(
        handle.db,
        { row, secretValue },
        {
          auditId: audit.auditId,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          reason: audit.reason,
          occurredAt: now,
          before: audit.before,
          after: audit.after,
        },
      );
      return outcome.applied;
    },
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
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: input.applied
        ? `rotated credential for ${input.destinationId}`
        : `${input.destinationId}: no row updated`,
      json: {
        destination_id: input.destinationId,
        applied: input.applied,
      },
    }),
  );
}
