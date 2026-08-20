/**
 * `polaris topics deisolate --project <id> --env <env> --family <name>
 *   [--reason <text>]` — mutating.
 *
 * Deactivates an active topic isolation. Stamps `deactivated_at` on the
 * row and writes the audit record in the SAME transaction. The row
 * itself is preserved (no DELETE) so an operator can reconstruct the
 * lifecycle of past isolations without consulting the audit log.
 *
 * **Pre-condition: the dedicated topic must be drained.** This command
 * does not enforce drain status; that is an operational pre-condition
 * documented in the cutover runbook. Running deisolate before the
 * dedicated topic is empty causes the resolver to point new producers
 * back at the shared topic while the dedicated topic still holds
 * un-consumed messages — a recoverable state, but one that needs
 * manual replay from the dedicated topic onto the shared one.
 *
 * **`--reason` is optional.** A default rationale (`topics.deisolate:
 * <family> for <project> in <env>`) is stamped when omitted so the
 * audit row carries non-null context.
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

import { POLARIS_ENVIRONMENTS } from "@polaris/runtime-environments";
import {
  CANONICAL_STREAM_FAMILIES,
  type CanonicalStreamFamily,
  isCanonicalStreamFamily,
} from "@polaris/bus";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  deisolateTopicWithAudit,
  findActiveIsolation,
  findLatestIsolationByTriple,
  findTopicIsolationById,
  type TopicIsolationRow,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import type { TopicIsolationAuditSnapshot } from "./isolate.js";

const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

const PROJECT_ID_FORMAT = /^[a-z0-9][a-z0-9_-]{0,126}[a-z0-9]$/;

/**
 * Snapshot stored on `audit_records.before` and `.after` for
 * `topics.deisolate`. `before` is the active row (with
 * `deactivated_at: null`); `after` is the same row with
 * `deactivated_at` set to the deactivation timestamp.
 */
export interface TopicIsolationDeisolateSnapshot extends TopicIsolationAuditSnapshot {
  readonly deactivated_at: string | null;
}

export interface TopicsDeisolateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly before: TopicIsolationDeisolateSnapshot;
  readonly after: TopicIsolationDeisolateSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly reason: string;
}

export interface TopicsDeisolateStore {
  findActive(
    family: CanonicalStreamFamily,
    projectId: string,
    environment: string,
  ): Promise<TopicIsolationRow | null>;
  findLatest(
    family: CanonicalStreamFamily,
    projectId: string,
    environment: string,
  ): Promise<TopicIsolationRow | null>;
  /**
   * Deactivate the row AND persist an audit row in the SAME
   * transaction. Returns `true` when both writes landed (a real
   * transition); `false` when the UPDATE updated zero rows (another
   * caller deactivated the row first).
   */
  deactivateWithAudit(id: string, now: Date, audit: TopicsDeisolateAuditPayload): Promise<boolean>;
  close(): Promise<void>;
}

export interface TopicsDeisolateHooks {
  readonly openStore?: () => TopicsDeisolateStore;
  readonly generateAuditId?: () => string;
  readonly now?: () => Date;
  readonly actorLabel?: () => string;
}

interface TopicsDeisolateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly family?: string;
  readonly reason?: string;
}

export const topicsDeisolateCommand: CommandDefinition = {
  id: "topics.deisolate",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("deisolate")
      .description(
        [
          "Deactivate an active topic isolation. Stamps deactivated_at and writes",
          "an audit_records row in one transaction.",
          "",
          "Pre-condition: the dedicated topic must be drained before deisolation.",
          "See docs/operations/topic-isolation-cutover.md for the producer/consumer",
          "drain sequence.",
        ].join("\n"),
      )
      .requiredOption("--project <project_id>", "Project whose isolation should be removed.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .requiredOption(
        "--family <family>",
        `Canonical topic family: ${CANONICAL_STREAM_FAMILIES.join(" | ")}.`,
      )
      .option(
        "--reason <reason>",
        "Operator rationale stamped on the audit record (optional). " +
          "Defaults to `topics.deisolate: <family> for <project> in <env>` when omitted.",
      )
      .action(deps.runCommand({ id: "topics.deisolate", mutates: true }, runTopicsDeisolate));
  },
};

export function buildTopicsDeisolateRunner(hooks: TopicsDeisolateHooks = {}) {
  const generateAuditId = hooks.generateAuditId ?? (() => `polaris_aud_${uuidv7()}`);
  const nowFn = hooks.now ?? (() => new Date());
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: TopicsDeisolateArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const validated = validate(args);
    const actorLabel = actorLabelOverride?.() ?? ctx.actor.label;
    const reason =
      validated.reason ??
      `topics.deisolate: ${validated.family} for ${validated.project} in ${validated.env}`;

    const store = openStore();
    try {
      const active = await store.findActive(validated.family, validated.project, validated.env);
      if (active === null) {
        // Look up the most recent row to surface a friendly message:
        // either "there is no isolation at all" or "the most recent
        // isolation is already deactivated".
        const latest = await store.findLatest(validated.family, validated.project, validated.env);
        if (latest === null) {
          throw new UsageError(
            `topic_isolations: no isolation exists for project "${validated.project}", family "${validated.family}", environment "${validated.env}".`,
          );
        }
        throw new UsageError(
          `topic_isolations: most recent isolation for project "${validated.project}", family "${validated.family}", environment "${validated.env}" was already deactivated at ${latest.deactivated_at ?? "unknown"}.`,
        );
      }

      const now = nowFn();
      const auditId = generateAuditId();
      const before: TopicIsolationDeisolateSnapshot = {
        id: active.id,
        project_id: active.project_id,
        environment: active.environment,
        topic_family: active.topic_family,
        concrete_topic: active.concrete_topic,
        reason: active.reason,
        actor_id: active.actor_id,
        activated_at: active.activated_at,
        deactivated_at: active.deactivated_at,
      };
      const after: TopicIsolationDeisolateSnapshot = {
        ...before,
        deactivated_at: now.toISOString(),
      };
      const auditPayload: TopicsDeisolateAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel,
        occurredAt: now,
        before,
        after,
        projectId: validated.project,
        environment: validated.env as AuditEnvironment,
        reason,
      };

      const applied = await store.deactivateWithAudit(active.id, now, auditPayload);
      if (!applied) {
        // A concurrent run won — surface a friendly message so the
        // operator does not see an exit code 0 + "applied: false"
        // without context.
        emit(ctx, {
          id: active.id,
          project: validated.project,
          env: validated.env,
          family: validated.family,
          concreteTopic: active.concrete_topic,
          applied: false,
          deactivatedAt: null,
          reason,
        });
        return undefined;
      }

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "topics.deisolate",
          topic_isolation_id: active.id,
          project_id: validated.project,
          environment: validated.env,
          topic_family: validated.family,
          concrete_topic: active.concrete_topic,
          reason,
          occurred_at: now.toISOString(),
        },
        "topic isolation deactivated (audit row persisted)",
      );

      emit(ctx, {
        id: active.id,
        project: validated.project,
        env: validated.env,
        family: validated.family,
        concreteTopic: active.concrete_topic,
        applied: true,
        deactivatedAt: now.toISOString(),
        reason,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runTopicsDeisolate = buildTopicsDeisolateRunner();

function defaultStore(env: NodeJS.ProcessEnv): TopicsDeisolateStore {
  const handle = connectDb({ env });
  return {
    findActive: (family, projectId, environment) =>
      findActiveIsolation(handle.db, family, projectId, environment),
    findLatest: (family, projectId, environment) =>
      findLatestIsolationByTriple(handle.db, family, projectId, environment),
    deactivateWithAudit: async (id, now, audit) => {
      const row = await findTopicIsolationById(handle.db, id);
      if (row === null) return false;
      const outcome = await deisolateTopicWithAudit(
        handle.db,
        { row },
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

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
  readonly family: CanonicalStreamFamily;
  readonly reason: string | undefined;
}

function validate(args: TopicsDeisolateArgs): ValidatedArgs {
  const project = requireTrim(args.project, "--project");
  const env = requireTrim(args.env, "--env");
  const family = requireTrim(args.family, "--family");

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

  const reason = parseReason(args.reason);

  return {
    project,
    env: env as SupportedEnvironment,
    family,
    reason,
  };
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
  readonly id: string;
  readonly project: string;
  readonly env: string;
  readonly family: string;
  readonly concreteTopic: string;
  readonly applied: boolean;
  readonly deactivatedAt: string | null;
  readonly reason: string;
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
        applied: input.applied,
        deactivated_at: input.deactivatedAt,
        reason: input.reason,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  if (!input.applied) {
    return `${input.id}: deisolate did not apply (concurrent run won the race; verify with \`polaris topics list\`)`;
  }
  return [
    "topic isolation deactivated",
    `  id              ${input.id}`,
    `  project_id      ${input.project}`,
    `  environment     ${input.env}`,
    `  topic_family    ${input.family}`,
    `  concrete_topic  ${input.concreteTopic}`,
    `  deactivated_at  ${input.deactivatedAt ?? "(unknown)"}`,
    `  reason          ${input.reason}`,
    "",
    "The runtime resolver will return the shared family topic within one cache TTL window.",
    "Verify that consumers re-subscribe and the dedicated topic remains drained before",
    "tearing it down via Terraform / pulumi.",
  ].join("\n");
}
