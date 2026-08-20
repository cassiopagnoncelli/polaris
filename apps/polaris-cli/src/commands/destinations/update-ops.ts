/**
 * `polaris destinations update-ops <destination_id>
 *   [--max-concurrency <n>] [--max-rps <n>]
 *   [--retry-policy <profile>] [--dead-letter-threshold <n>]
 *   --reason <reason>` — mutating.
 *
 * Update the operational tuning fields on one destination instance. ONLY
 * the four operational knobs are accepted. Any flag/argument that resembles
 * a mapping field (`--map`, `--event-map`, `--field-map`, `--target-field`,
 * ...) is rejected BEFORE any DB write.
 *
 * The validation contract is the central architectural guarantee for
 * P6-004's acceptance criterion "CLI cannot define event-to-vendor
 * mappings": even though commander's `--option` surface only declares the
 * four operational knobs, the runtime `rejectMappingArguments` gate catches
 * any mapping-shaped token someone tries to smuggle through.
 *
 * Audit trail: when the UPDATE lands, this command writes an `audit_records`
 * row in the SAME transaction. `before` snapshots the row pre-update,
 * `after` snapshots the row post-update. The `--reason` flag is required
 * (matching `destinations.disable`) so every operational mutation carries a
 * structured rationale on its audit row.
 *
 * `mutates: true` — P6-007 gates this in production.
 */
import type { DestinationRetryPolicy } from "@polaris/persistence-postgres";
import type { Command } from "commander";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type DestinationRow,
  findDestinationById,
  type UpdateDestinationOpsInput,
  updateDestinationOpsWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationAuditSnapshot } from "./enable.js";
import { rejectMappingArguments } from "./validation.js";

const SUPPORTED_RETRY_POLICIES: readonly DestinationRetryPolicy[] = [
  "standard",
  "aggressive",
  "conservative",
] as const;

interface DestinationsUpdateOpsArgs {
  readonly destinationId: string;
  readonly maxConcurrency?: string;
  readonly maxRps?: string;
  readonly retryPolicy?: string;
  readonly deadLetterThreshold?: string;
  readonly reason?: string;
}

export interface DestinationsUpdateOpsAuditPayload {
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

export interface DestinationsUpdateOpsStore {
  findById(destinationId: string): Promise<DestinationRow | null>;
  updateWithAudit(
    destinationId: string,
    patch: UpdateDestinationOpsInput,
    now: Date,
    audit: DestinationsUpdateOpsAuditPayload,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface DestinationsUpdateOpsHooks {
  readonly openStore?: () => DestinationsUpdateOpsStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export const destinationsUpdateOpsCommand: CommandDefinition = {
  id: "destinations.update-ops",
  mutates: true,
  register: (parent, deps) => {
    const cmd = parent
      .command("update-ops <destination_id>")
      .description(
        [
          "Update operational tuning on a destination instance.",
          "Only operational knobs are accepted: --max-concurrency, --max-rps,",
          "--retry-policy, --dead-letter-threshold. Any flag resembling a mapping",
          "field (--map, --event-map, --field-map, --target-field, ...) is rejected.",
        ].join("\n"),
      )
      .option("--max-concurrency <n>", "Per-instance worker concurrency (positive integer).")
      .option("--max-rps <n>", "Outbound rate cap (positive integer).")
      .option("--retry-policy <profile>", `Retry profile: ${SUPPORTED_RETRY_POLICIES.join(" | ")}.`)
      .option(
        "--dead-letter-threshold <n>",
        "Attempts after which a message is routed to the DLQ (positive integer).",
      )
      .requiredOption(
        "--reason <reason>",
        "Operator rationale for the audit record. Free text, required.",
      );
    cmd.action(
      async (
        destinationId: string,
        opts: {
          maxConcurrency?: string;
          maxRps?: string;
          retryPolicy?: string;
          deadLetterThreshold?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<DestinationsUpdateOpsArgs>(
          { id: "destinations.update-ops", mutates: true },
          runDestinationsUpdateOps,
        );
        const args: DestinationsUpdateOpsArgs = {
          destinationId,
          ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
          ...(opts.maxRps !== undefined ? { maxRps: opts.maxRps } : {}),
          ...(opts.retryPolicy !== undefined ? { retryPolicy: opts.retryPolicy } : {}),
          ...(opts.deadLetterThreshold !== undefined
            ? { deadLetterThreshold: opts.deadLetterThreshold }
            : {}),
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        };
        // Pass the full opts bag through so rejectMappingArguments can see
        // whatever commander parsed, not just the four declared options.
        // The dispatcher hands us the typed args, but tests drive the runner
        // directly with the same arg shape — the gate fires in both paths.
        const reject: Record<string, unknown> = { ...opts };
        rejectMappingArguments(reject);
        await wrapped(args, command);
      },
    );
  },
};

export function buildDestinationsUpdateOpsRunner(hooks: DestinationsUpdateOpsHooks = {}) {
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(
    args: DestinationsUpdateOpsArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    // Defense-in-depth: the dispatcher path already calls
    // `rejectMappingArguments` against the raw commander opts. The runner
    // path (driven by tests and any future programmatic caller) runs the
    // same check against the typed arg shape so a smuggled `field_map`
    // property still gets rejected before any validation or DB work.
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

    const patch = validatePatch(args);
    if (
      patch.max_concurrency === undefined &&
      patch.max_rps === undefined &&
      patch.retry_policy === undefined &&
      patch.dead_letter_threshold === undefined
    ) {
      throw new UsageError(
        "update-ops requires at least one of: --max-concurrency, --max-rps, " +
          "--retry-policy, --dead-letter-threshold",
      );
    }

    const store = openStore();
    try {
      const existing = await store.findById(id);
      if (existing === null) {
        throw new UsageError(`destination "${id}" not found`);
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const before = toSnapshot(existing);
      const after: DestinationAuditSnapshot = {
        ...before,
        ...(patch.max_concurrency !== undefined ? { max_concurrency: patch.max_concurrency } : {}),
        ...(patch.max_rps !== undefined ? { max_rps: patch.max_rps } : {}),
        ...(patch.retry_policy !== undefined ? { retry_policy: patch.retry_policy } : {}),
        ...(patch.dead_letter_threshold !== undefined
          ? { dead_letter_threshold: patch.dead_letter_threshold }
          : {}),
      };
      const auditPayload: DestinationsUpdateOpsAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        before,
        after,
        projectId: existing.project_id,
        environment: existing.environment as AuditEnvironment,
        reason,
      };

      const applied = await store.updateWithAudit(id, patch, now, auditPayload);
      const afterRow = await store.findById(id);
      if (afterRow === null) {
        // Should be impossible: we just confirmed the row exists. Surface
        // a usage error rather than crash so scripts see exit code 2.
        throw new UsageError(`destination "${id}" disappeared during update`);
      }

      if (applied) {
        ctx.logger.info(
          {
            audit_id: auditId,
            audit_action: "destinations.update-ops",
            destination_id: id,
            project_id: existing.project_id,
            environment: existing.environment,
            reason,
            occurred_at: now.toISOString(),
          },
          "destination ops updated (audit row persisted)",
        );
      }

      emit(ctx, { applied, before: existing, after: afterRow, patch });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsUpdateOps = buildDestinationsUpdateOpsRunner();

function defaultStore(env: NodeJS.ProcessEnv): DestinationsUpdateOpsStore {
  const handle = connectDb({ env });
  return {
    findById: (id) => findDestinationById(handle.db, id),
    updateWithAudit: async (id, patch, now, audit) => {
      const row = await findDestinationById(handle.db, id);
      if (row === null) return false;
      const outcome = await updateDestinationOpsWithAudit(
        handle.db,
        { row, patch },
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

function validatePatch(args: DestinationsUpdateOpsArgs): UpdateDestinationOpsInput {
  const patch: UpdateDestinationOpsInput = {};
  const out = patch as {
    max_concurrency?: number;
    max_rps?: number;
    retry_policy?: DestinationRetryPolicy;
    dead_letter_threshold?: number;
  };
  const maxConcurrency = parsePositiveInt(args.maxConcurrency, "--max-concurrency", 1, 1024);
  if (maxConcurrency !== undefined) out.max_concurrency = maxConcurrency;
  const maxRps = parsePositiveInt(args.maxRps, "--max-rps", 1, 100_000);
  if (maxRps !== undefined) out.max_rps = maxRps;
  const retryPolicy = parseRetryPolicy(args.retryPolicy);
  if (retryPolicy !== undefined) out.retry_policy = retryPolicy;
  const deadLetterThreshold = parsePositiveInt(
    args.deadLetterThreshold,
    "--dead-letter-threshold",
    1,
    1000,
  );
  if (deadLetterThreshold !== undefined) out.dead_letter_threshold = deadLetterThreshold;
  return patch;
}

function parsePositiveInt(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new UsageError(`${flag} must be a positive integer (got "${trimmed}")`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max} (got ${value})`);
  }
  return value;
}

function parseRetryPolicy(raw: string | undefined): DestinationRetryPolicy | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!(SUPPORTED_RETRY_POLICIES as readonly string[]).includes(trimmed)) {
    throw new UsageError(
      `--retry-policy must be one of: ${SUPPORTED_RETRY_POLICIES.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as DestinationRetryPolicy;
}

interface EmitInput {
  readonly applied: boolean;
  readonly before: DestinationRow;
  readonly after: DestinationRow;
  readonly patch: UpdateDestinationOpsInput;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  const changedFields = describeChanges(input.before, input.after);
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input, changedFields),
      json: {
        destination_id: input.after.destination_id,
        applied: input.applied,
        changes: changedFields,
        after: {
          max_concurrency: input.after.max_concurrency,
          max_rps: input.after.max_rps,
          retry_policy: input.after.retry_policy,
          dead_letter_threshold: input.after.dead_letter_threshold,
        },
      },
    }),
  );
}

function describeChanges(
  before: DestinationRow,
  after: DestinationRow,
): Record<string, { from: number | string; to: number | string }> {
  const changes: Record<string, { from: number | string; to: number | string }> = {};
  if (before.max_concurrency !== after.max_concurrency) {
    changes["max_concurrency"] = { from: before.max_concurrency, to: after.max_concurrency };
  }
  if (before.max_rps !== after.max_rps) {
    changes["max_rps"] = { from: before.max_rps, to: after.max_rps };
  }
  if (before.retry_policy !== after.retry_policy) {
    changes["retry_policy"] = { from: before.retry_policy, to: after.retry_policy };
  }
  if (before.dead_letter_threshold !== after.dead_letter_threshold) {
    changes["dead_letter_threshold"] = {
      from: before.dead_letter_threshold,
      to: after.dead_letter_threshold,
    };
  }
  return changes;
}

function renderHuman(
  input: EmitInput,
  changes: Record<string, { from: number | string; to: number | string }>,
): string {
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return `${input.after.destination_id}: no operational changes`;
  }
  const lines = [`updated ${input.after.destination_id}`];
  for (const key of keys) {
    const entry = changes[key];
    if (entry === undefined) continue;
    lines.push(`  ${key} ${entry.from} -> ${entry.to}`);
  }
  return lines.join("\n");
}
