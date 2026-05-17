/**
 * `polaris destinations create --project <id> --env <env> --vendor <vendor>
 *   --instance-label <label> --secret-ref <provider:ref>
 *   [--mode <live|sandbox|test>] [--max-concurrency <n>] [--max-rps <n>]
 *   [--retry-policy <profile>] [--dead-letter-threshold <n>] [--reason <text>]`
 *
 * Mutating: inserts one destination row scoped to a
 * `(project_id, environment, vendor, instance_label)` tuple. The
 * `destination_id` is platform-issued as `polaris_dst_<uuidv7>` so operators
 * never pass it in.
 *
 * **Mapping rule:** the CLI MUST NOT accept any flag/argument that resembles
 * mapping semantics. Mapping semantics (event-to-vendor field maps) live in
 * versioned consumer code under `consumers/<vendor>/v<n>/mappers/`. The
 * argument validator rejects mapping-shaped flags BEFORE any DB write.
 *
 * Audit trail: when the insert lands, this command writes an `audit_records`
 * row in the SAME transaction as the INSERT. `before` is null (no prior row).
 * `after` is a snapshot of the inserted row — including the operational
 * tuning columns and the `secret_ref` literal, never a resolved secret. The
 * `--reason` flag is optional; when omitted the runner stamps a default
 * `destinations.create: <vendor> instance <label>` reason so the audit row
 * always carries non-null context.
 *
 * `mutates: true` so the P6-007 production gate picks this command up
 * automatically.
 */
import type { DestinationMode, DestinationRetryPolicy } from "@polaris/shared-db";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type InsertDestinationInput,
  insertAuditRecord,
  insertDestination,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { DestinationAuditSnapshot } from "./enable.js";
import { generateDestinationId } from "./id.js";
import { rejectMappingArguments, validateSecretRef } from "./validation.js";

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

const SUPPORTED_MODES: readonly DestinationMode[] = ["live", "sandbox", "test"] as const;
const SUPPORTED_RETRY_POLICIES: readonly DestinationRetryPolicy[] = [
  "standard",
  "aggressive",
  "conservative",
] as const;

const VENDOR_FORMAT = /^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/;
const INSTANCE_LABEL_FORMAT = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_RPS = 50;
const DEFAULT_RETRY_POLICY: DestinationRetryPolicy = "standard";
const DEFAULT_DEAD_LETTER_THRESHOLD = 5;

export interface DestinationsCreateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: DestinationAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

export interface DestinationsCreateStore {
  insertWithAudit(
    input: InsertDestinationInput,
    audit: DestinationsCreateAuditPayload,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface DestinationsCreateHooks {
  readonly issueId?: () => string;
  readonly openStore?: () => DestinationsCreateStore;
  readonly generateAuditId?: () => string;
  readonly now?: () => Date;
  readonly actorLabel?: () => string;
}

interface DestinationsCreateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly vendor?: string;
  readonly instanceLabel?: string;
  readonly secretRef?: string;
  readonly mode?: string;
  readonly maxConcurrency?: string;
  readonly maxRps?: string;
  readonly retryPolicy?: string;
  readonly deadLetterThreshold?: string;
  readonly reason?: string;
}

export const destinationsCreateCommand: CommandDefinition = {
  id: "destinations.create",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("create")
      .description(
        [
          "Create a destination instance. Stores runtime state only.",
          "Mapping semantics (event-to-vendor maps) live in code under consumers/<vendor>/v<n>/mappers/,",
          "NEVER in PostgreSQL — this CLI refuses any flag that resembles a mapping field.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project this destination belongs to.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .requiredOption("--vendor <vendor>", "Vendor adapter (e.g. meta-capi, ga4, webhook-sink).")
      .requiredOption("--instance-label <label>", "Operator-supplied short label.")
      .requiredOption(
        "--secret-ref <provider:ref>",
        "Provider-namespaced secret reference (e.g. env:META_CAPI_TOKEN_STOREFRONT_PROD). " +
          "Plaintext is never accepted.",
      )
      .option("--mode <mode>", `Delivery mode: ${SUPPORTED_MODES.join(" | ")} (default: live).`)
      .option(
        "--max-concurrency <n>",
        "Per-instance worker concurrency (operational tuning, default: 4).",
      )
      .option("--max-rps <n>", "Outbound rate cap (operational tuning, default: 50).")
      .option(
        "--retry-policy <profile>",
        `Retry profile: ${SUPPORTED_RETRY_POLICIES.join(" | ")} (default: standard).`,
      )
      .option(
        "--dead-letter-threshold <n>",
        "Attempts after which a message is routed to the DLQ (default: 5).",
      )
      .option(
        "--reason <reason>",
        "Operator rationale stamped on the audit record (optional). " +
          "Defaults to `destinations.create: <vendor> instance <label>` when omitted.",
      )
      .action(deps.runCommand({ id: "destinations.create", mutates: true }, runDestinationsCreate));
  },
};

export function buildDestinationsCreateRunner(hooks: DestinationsCreateHooks = {}) {
  const issueId = hooks.issueId ?? generateDestinationId;
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const nowFn = hooks.now ?? (() => new Date());
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(
    args: DestinationsCreateArgs,
    ctx: CommandContext,
  ): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    // Refuse mapping-shaped flags BEFORE any validation or DB work. This is
    // the acceptance-criteria gate: even though the option surface above
    // doesn't declare such flags, commander accepts trailing positional
    // values and runtime spread; this defense-in-depth check guarantees
    // mapping semantics cannot reach the DB.
    rejectMappingArguments(args as unknown as Record<string, unknown>);

    const validated = validate(args);
    const destinationId = issueId();
    const insertInput: InsertDestinationInput = {
      destination_id: destinationId,
      project_id: validated.project,
      environment: validated.env,
      vendor: validated.vendor,
      instance_label: validated.instanceLabel,
      secret_ref: validated.secretRef,
      mode: validated.mode,
      ...(validated.maxConcurrency !== undefined
        ? { max_concurrency: validated.maxConcurrency }
        : {}),
      ...(validated.maxRps !== undefined ? { max_rps: validated.maxRps } : {}),
      ...(validated.retryPolicy !== undefined ? { retry_policy: validated.retryPolicy } : {}),
      ...(validated.deadLetterThreshold !== undefined
        ? { dead_letter_threshold: validated.deadLetterThreshold }
        : {}),
    };

    const now = nowFn();
    const auditId = generateAuditId();
    const reason =
      validated.reason ??
      `destinations.create: ${validated.vendor} instance ${validated.instanceLabel}`;
    const after: DestinationAuditSnapshot = {
      destination_id: destinationId,
      project_id: validated.project,
      environment: validated.env,
      vendor: validated.vendor,
      instance_label: validated.instanceLabel,
      secret_ref: validated.secretRef,
      status: "active",
      mode: validated.mode,
      max_concurrency: validated.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      max_rps: validated.maxRps ?? DEFAULT_MAX_RPS,
      retry_policy: validated.retryPolicy ?? DEFAULT_RETRY_POLICY,
      dead_letter_threshold: validated.deadLetterThreshold ?? DEFAULT_DEAD_LETTER_THRESHOLD,
      disabled_reason: null,
    };
    const auditPayload: DestinationsCreateAuditPayload = {
      auditId,
      actorSource: ctx.actor.source,
      actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
      occurredAt: now,
      after,
      projectId: validated.project,
      environment: validated.env as AuditEnvironment,
      reason,
    };

    const store = openStore();
    try {
      await store.insertWithAudit(insertInput, auditPayload);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "destinations.create",
          destination_id: destinationId,
          project_id: validated.project,
          environment: validated.env,
          vendor: validated.vendor,
          instance_label: validated.instanceLabel,
          mode: validated.mode,
          reason,
          occurred_at: now.toISOString(),
        },
        "destination created (audit row persisted)",
      );

      emit(ctx, { ...validated, destinationId, secretProvider: validated.secretProvider });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runDestinationsCreate = buildDestinationsCreateRunner();

function defaultStore(env: NodeJS.ProcessEnv): DestinationsCreateStore {
  const handle = connectDb({ env });
  return {
    insertWithAudit: async (input, audit) =>
      handle.db.transaction().execute(async (trx) => {
        await insertDestination(trx, input);
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "destinations.create",
          target_type: "destination",
          target_id: input.destination_id,
          project_id: audit.projectId,
          environment: audit.environment,
          before: null,
          after: audit.after,
          reason: audit.reason,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
      }),
    close: () => handle.close(),
  };
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
  readonly vendor: string;
  readonly instanceLabel: string;
  readonly secretRef: string;
  readonly secretProvider: string;
  readonly mode: DestinationMode;
  readonly maxConcurrency: number | undefined;
  readonly maxRps: number | undefined;
  readonly retryPolicy: DestinationRetryPolicy | undefined;
  readonly deadLetterThreshold: number | undefined;
  readonly reason: string | undefined;
}

function validate(args: DestinationsCreateArgs): ValidatedArgs {
  const project = requireTrim(args.project, "--project");
  const env = requireTrim(args.env, "--env");
  const vendor = requireTrim(args.vendor, "--vendor");
  const instanceLabel = requireTrim(args.instanceLabel, "--instance-label");
  const secretRef = requireTrim(args.secretRef, "--secret-ref");

  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  if (!VENDOR_FORMAT.test(vendor)) {
    throw new UsageError(
      `--vendor "${vendor}" is invalid. ` +
        "Allowed shape: lowercase alphanumeric with underscores or hyphens, 3-64 chars.",
    );
  }
  if (!INSTANCE_LABEL_FORMAT.test(instanceLabel)) {
    throw new UsageError(
      `--instance-label "${instanceLabel}" is invalid. ` +
        "Allowed shape: lowercase alphanumeric with underscores or hyphens, 2-64 chars.",
    );
  }
  const parsedSecret = validateSecretRef(secretRef);

  const mode = parseMode(args.mode);
  const maxConcurrency = parsePositiveInt(args.maxConcurrency, "--max-concurrency", 1, 1024);
  const maxRps = parsePositiveInt(args.maxRps, "--max-rps", 1, 100_000);
  const retryPolicy = parseRetryPolicy(args.retryPolicy);
  const deadLetterThreshold = parsePositiveInt(
    args.deadLetterThreshold,
    "--dead-letter-threshold",
    1,
    1000,
  );
  const reason = parseReason(args.reason);

  return {
    project,
    env: env as SupportedEnvironment,
    vendor,
    instanceLabel,
    secretRef,
    secretProvider: parsedSecret.provider,
    mode,
    maxConcurrency,
    maxRps,
    retryPolicy,
    deadLetterThreshold,
    reason,
  };
}

function parseMode(raw: string | undefined): DestinationMode {
  if (raw === undefined) return "live";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "live";
  if (!(SUPPORTED_MODES as readonly string[]).includes(trimmed)) {
    throw new UsageError(`--mode must be one of: ${SUPPORTED_MODES.join(", ")} (got "${trimmed}")`);
  }
  return trimmed as DestinationMode;
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

function parseReason(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 1024) {
    throw new UsageError("--reason must be 1024 characters or fewer");
  }
  return trimmed;
}

function requireTrim(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new UsageError(`${flag} is required`);
  return trimmed;
}

interface EmitInput {
  readonly destinationId: string;
  readonly project: string;
  readonly env: string;
  readonly vendor: string;
  readonly instanceLabel: string;
  readonly secretRef: string;
  readonly secretProvider: string;
  readonly mode: DestinationMode;
  readonly maxConcurrency: number | undefined;
  readonly maxRps: number | undefined;
  readonly retryPolicy: DestinationRetryPolicy | undefined;
  readonly deadLetterThreshold: number | undefined;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        destination_id: input.destinationId,
        project_id: input.project,
        environment: input.env,
        vendor: input.vendor,
        instance_label: input.instanceLabel,
        secret_ref: input.secretRef,
        secret_provider: input.secretProvider,
        mode: input.mode,
        max_concurrency: input.maxConcurrency ?? null,
        max_rps: input.maxRps ?? null,
        retry_policy: input.retryPolicy ?? null,
        dead_letter_threshold: input.deadLetterThreshold ?? null,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  const lines = [
    `polaris destination created`,
    `  destination_id  ${input.destinationId}`,
    `  project_id      ${input.project}`,
    `  environment     ${input.env}`,
    `  vendor          ${input.vendor}`,
    `  instance_label  ${input.instanceLabel}`,
    `  secret_ref      ${input.secretRef}`,
    `  mode            ${input.mode}`,
  ];
  if (input.maxConcurrency !== undefined) {
    lines.push(`  max_concurrency ${input.maxConcurrency}`);
  }
  if (input.maxRps !== undefined) {
    lines.push(`  max_rps         ${input.maxRps}`);
  }
  if (input.retryPolicy !== undefined) {
    lines.push(`  retry_policy    ${input.retryPolicy}`);
  }
  if (input.deadLetterThreshold !== undefined) {
    lines.push(`  dlq_threshold   ${input.deadLetterThreshold}`);
  }
  return lines.join("\n");
}
