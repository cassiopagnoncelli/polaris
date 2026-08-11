/**
 * `polaris topics isolate --project <id> --env <env> --family <name>
 *   --reason <text>` — mutating.
 *
 * Activates topic isolation for a `(family, project_id, environment)`
 * triple. Inserts one row into `topic_isolations`, materializes the
 * concrete dedicated topic name (`<family>.<project_id>`), and writes
 * the audit record in the SAME transaction so isolation state and
 * audit trail are always consistent.
 *
 * **What this command does NOT do.** It does NOT cut producers or
 * consumers over to the dedicated topic. The runtime resolver in
 * `@polaris/shared-transport` reads the active row through a TTL-bounded
 * cache, so the cutover becomes live within one TTL window across all
 * services that wired the cache in. The
 * `docs/operations/topic-isolation-cutover.md` runbook walks operators
 * through the producer-first / consumer-second sequence.
 *
 * **One active isolation per triple.** The migration's partial unique
 * index rejects a duplicate active row; the runner translates the
 * resulting PostgreSQL error into a typed usage error so the operator
 * sees a friendly message ("project foo is already isolated for family
 * raw.events in production") instead of a stack trace.
 *
 * `mutates: true`. The P6-007 dispatcher gate refuses this command
 * against `POLARIS_ENV=production` when the actor source is
 * `'declared'`; the operator must run with a valid
 * `POLARIS_OPERATOR_TOKEN`.
 *
 * @see docs/architecture/03-rabbitmq-streams.md "Topic Isolation Triggers"
 * @see docs/operations/topic-isolation-cutover.md
 * @see docs/implementation/tasks/P11-008-topic-isolation.md
 */
import {
  CANONICAL_STREAM_FAMILIES,
  type CanonicalStreamFamily,
  dedicatedStreamFamily,
  isCanonicalStreamFamily,
} from "@polaris/shared-transport";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  type InsertTopicIsolationInput,
  isolateTopicWithAudit,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

const PROJECT_ID_FORMAT = /^[a-z0-9][a-z0-9_-]{0,126}[a-z0-9]$/;

/** Prefix for topic-isolation row ids. UUIDv7 tail keeps inserts strictly monotonic. */
export const TOPIC_ISOLATION_ID_PREFIX = "polaris_tiso_" as const;

/**
 * Snapshot stored on `audit_records.after` for `topics.isolate`. Mirrors
 * the row shape minus the server-stamped timestamps. `before` is null
 * (no prior row) for activation events; reactivation after a previous
 * deactivation creates a new id, so the activation is always a "new
 * row" from the audit log's perspective.
 */
export interface TopicIsolationAuditSnapshot {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly topic_family: string;
  readonly concrete_topic: string;
  readonly reason: string;
  readonly actor_id: string;
  readonly activated_at: string;
}

export interface TopicsIsolateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: TopicIsolationAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

/**
 * Store contract: persist the isolation row + audit row in one
 * transaction. The default Kysely-backed implementation lives at the
 * bottom of this file; tests inject in-memory adapters.
 *
 * Returns `'inserted'` when the new active row landed; returns
 * `'duplicate'` when the migration's partial unique index rejected the
 * INSERT because another active row already exists for this triple.
 * The runner translates `'duplicate'` into a typed usage error so the
 * operator sees a friendly message.
 */
export type IsolateInsertOutcome = "inserted" | "duplicate";

export interface TopicsIsolateStore {
  insertWithAudit(
    input: InsertTopicIsolationInput,
    audit: TopicsIsolateAuditPayload,
  ): Promise<IsolateInsertOutcome>;
  close(): Promise<void>;
}

export interface TopicsIsolateHooks {
  readonly openStore?: () => TopicsIsolateStore;
  readonly issueId?: () => string;
  readonly generateAuditId?: () => string;
  readonly now?: () => Date;
  readonly actorLabel?: () => string;
}

interface TopicsIsolateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly family?: string;
  readonly reason?: string;
}

export const topicsIsolateCommand: CommandDefinition = {
  id: "topics.isolate",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("isolate")
      .description(
        [
          "Activate dedicated-topic isolation for a (family, project, environment) triple.",
          "Writes a topic_isolations row + audit_records row in one transaction.",
          "",
          "The runtime resolver reads the active row through a TTL-bounded cache, so",
          "the cutover becomes live within one TTL window across all services. See",
          "docs/operations/topic-isolation-cutover.md for the producer/consumer sequence.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project to isolate.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .requiredOption(
        "--family <family>",
        `Canonical topic family: ${CANONICAL_STREAM_FAMILIES.join(" | ")}.`,
      )
      .requiredOption(
        "--reason <reason>",
        "Operator-supplied rationale stamped on the audit record (free text, required).",
      )
      .action(deps.runCommand({ id: "topics.isolate", mutates: true }, runTopicsIsolate));
  },
};

export function buildTopicsIsolateRunner(hooks: TopicsIsolateHooks = {}) {
  const issueId = hooks.issueId ?? (() => `${TOPIC_ISOLATION_ID_PREFIX}${uuidv7()}`);
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const nowFn = hooks.now ?? (() => new Date());
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: TopicsIsolateArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const validated = validate(args);
    const now = nowFn();
    const id = issueId();
    const concreteTopic = dedicatedStreamFamily(validated.family, validated.project);
    const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;
    const auditId = generateAuditId();

    const insertInput: InsertTopicIsolationInput = {
      id,
      project_id: validated.project,
      environment: validated.env,
      topic_family: validated.family,
      concrete_topic: concreteTopic,
      reason: validated.reason,
      actor_id: actorLabel,
    };

    const after: TopicIsolationAuditSnapshot = {
      id,
      project_id: validated.project,
      environment: validated.env,
      topic_family: validated.family,
      concrete_topic: concreteTopic,
      reason: validated.reason,
      actor_id: actorLabel,
      activated_at: now.toISOString(),
    };
    const auditPayload: TopicsIsolateAuditPayload = {
      auditId,
      actorSource: ctx.actor.source,
      actorLabel,
      occurredAt: now,
      after,
      projectId: validated.project,
      environment: validated.env as AuditEnvironment,
      reason: validated.reason,
    };

    const store = openStore();
    try {
      const outcome = await store.insertWithAudit(insertInput, auditPayload);
      if (outcome === "duplicate") {
        throw new UsageError(
          `topic_isolations: project "${validated.project}" is already isolated for family "${validated.family}" in environment "${validated.env}". ` +
            "Run `polaris topics deisolate` first if you intend to cycle the isolation.",
        );
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "topics.isolate",
          topic_isolation_id: id,
          project_id: validated.project,
          environment: validated.env,
          topic_family: validated.family,
          concrete_topic: concreteTopic,
          reason: validated.reason,
          occurred_at: now.toISOString(),
        },
        "topic isolation activated (audit row persisted)",
      );

      emit(ctx, {
        id,
        project: validated.project,
        env: validated.env,
        family: validated.family,
        concreteTopic,
        reason: validated.reason,
        activatedAt: now.toISOString(),
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runTopicsIsolate = buildTopicsIsolateRunner();

function defaultStore(env: NodeJS.ProcessEnv): TopicsIsolateStore {
  const handle = connectDb({ env });
  return {
    insertWithAudit: async (input, audit): Promise<IsolateInsertOutcome> => {
      try {
        await isolateTopicWithAudit(handle.db, input, {
          auditId: audit.auditId,
          actorSource: audit.actorSource,
          actorLabel: audit.actorLabel,
          reason: audit.reason,
          occurredAt: audit.occurredAt,
          before: null,
          after: audit.after,
        });
        return "inserted";
      } catch (error) {
        // The partial unique index on (family, project, environment) WHERE
        // deactivated_at IS NULL is what enforces one active isolation per
        // triple; a duplicate is an operator mistake, not a failure.
        if (isUniqueViolation(error)) {
          return "duplicate";
        }
        throw error;
      }
    },
    close: () => handle.close(),
  };
}

/**
 * PostgreSQL's `unique_violation` error code is `23505`. The Kysely
 * error wraps the underlying `pg` `DatabaseError`, which surfaces the
 * code via the `code` property.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const obj = error as Record<string, unknown>;
  return obj["code"] === "23505";
}

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
  readonly family: CanonicalStreamFamily;
  readonly reason: string;
}

function validate(args: TopicsIsolateArgs): ValidatedArgs {
  const project = requireTrim(args.project, "--project");
  const env = requireTrim(args.env, "--env");
  const family = requireTrim(args.family, "--family");
  const reason = requireTrim(args.reason, "--reason");

  if (!PROJECT_ID_FORMAT.test(project)) {
    throw new UsageError(
      `--project "${project}" is invalid. ` +
        "Allowed shape: lowercase alphanumeric with underscores or hyphens, up to 128 chars.",
    );
  }
  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  if (!isCanonicalStreamFamily(family)) {
    throw new UsageError(
      `--family must be one of: ${CANONICAL_STREAM_FAMILIES.join(", ")} (got "${family}")`,
    );
  }
  if (reason.length > 1024) {
    throw new UsageError("--reason must be 1024 characters or fewer");
  }

  return {
    project,
    env: env as SupportedEnvironment,
    family,
    reason,
  };
}

function requireTrim(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new UsageError(`${flag} is required`);
  return trimmed;
}

interface EmitInput {
  readonly id: string;
  readonly project: string;
  readonly env: string;
  readonly family: string;
  readonly concreteTopic: string;
  readonly reason: string;
  readonly activatedAt: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        topic_isolation_id: input.id,
        project_id: input.project,
        environment: input.env,
        topic_family: input.family,
        concrete_topic: input.concreteTopic,
        reason: input.reason,
        activated_at: input.activatedAt,
        cutover_instructions: cutoverInstructions(input),
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  const lines = [
    "topic isolation activated",
    `  id              ${input.id}`,
    `  project_id      ${input.project}`,
    `  environment     ${input.env}`,
    `  topic_family    ${input.family}`,
    `  concrete_topic  ${input.concreteTopic}`,
    `  activated_at    ${input.activatedAt}`,
    `  reason          ${input.reason}`,
    "",
    "Cutover instructions:",
    ...cutoverInstructions(input).map((line) => `  ${line}`),
  ];
  return lines.join("\n");
}

/**
 * Operational instructions returned alongside the activation. Mirrors
 * the producer-first / consumer-second sequence from the cutover
 * runbook so the CLI output stays self-contained.
 */
function cutoverInstructions(input: EmitInput): readonly string[] {
  return [
    `1. Create the topic "${input.concreteTopic}" on RabbitMQ (e.g. via the same Terraform / pulumi module that owns "${input.family}"; partition count and retention should match or exceed the shared topic's settings).`,
    `2. Producers will start writing to "${input.concreteTopic}" within one resolver-cache TTL window (default 60s).`,
    `3. Wait for the shared topic "${input.family}" to drain for project "${input.project}" before stopping consumers from reading the shared partitions.`,
    `4. Once drained, restart consumers so they re-subscribe; the resolver picks up the dedicated topic on consumer-group reconnect.`,
    "5. Verify the per-project dashboards (per-project share / lag / partition skew / schema validation) reflect the cutover.",
    `6. Run \`polaris topics deisolate --project ${input.project} --env ${input.env} --family ${input.family}\` to roll back after the dedicated topic is drained.`,
  ];
}
