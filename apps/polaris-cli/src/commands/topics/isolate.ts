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

import { POLARIS_ENVIRONMENTS } from "@polaris/shared-environments";
import {
  CANONICAL_STREAM_FAMILIES,
  type CanonicalStreamFamily,
  isCanonicalStreamFamily,
} from "@polaris/shared-transport";
import type { CommandContext, CommandDefinition } from "../../command.js";
import type {
  AuditActorSource,
  AuditEnvironment,
  InsertTopicIsolationInput,
} from "../../db/index.js";
import { NotImplementedError, UsageError } from "../../errors.js";

const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;
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
          "REFUSED in this build: no service reads the isolation row, so writing one",
          "would change no traffic while reporting a cutover. See the runner for what",
          "wiring it requires.",
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

export function buildTopicsIsolateRunner(_hooks: TopicsIsolateHooks = {}) {
  return async function runner(args: TopicsIsolateArgs, _ctx: CommandContext): Promise<undefined> {
    // Validate first: a bad --env should read as a usage error, not as the
    // feature gap. The parsed value is named in the refusal so the operator
    // sees which triple was refused.
    const validated = validate(args);

    // Refuse, because the runtime does not honour the row this would write.
    //
    // `StreamIsolationCache` exists and is correct, and NOTHING constructs one:
    // every producer and every consumer in the platform resolves families
    // through `sharedOnlyIsolationLookup`, so an isolated project's events keep
    // flowing on the shared stream in both directions. Writing the row would
    // change no traffic while telling an operator — under incident pressure,
    // following a runbook that recommends exactly this — that a cutover is in
    // progress. A command that appears to act and does nothing is worse than
    // one that refuses.
    //
    // Wiring it is a real task: thread a `ScopedIsolationLookup` + cache
    // through every app, and give the destination runtime the
    // `isolatedProjects` option that `packages/shared-destinations/src/runtime.ts`
    // hardcodes to `[]`. Delete this guard in the same change that lands it.
    throw new NotImplementedError(
      [
        `topic isolation is not honoured by the runtime, so isolating ${validated.family} for ` +
          `${validated.project}/${validated.env} would write a row that changes nothing.`,
        "",
        "Every producer and consumer resolves stream families through sharedOnlyIsolationLookup;",
        "no service constructs a StreamIsolationCache. An isolated project's events would keep",
        "flowing on the shared stream, in both directions, while this command reported success.",
        "",
        "`polaris topics list` and `deisolate` still work, so existing rows remain inspectable",
        "and removable.",
      ].join("\n"),
    );
    // The write path lived here: issue an id, materialise the dedicated
    // topic name, upsert `topic_isolations` and its audit row, render the
    // cutover instructions. It is unreachable behind the refusal above and
    // biome's noUnreachable rightly flags dead code, so it is gone rather
    // than commented out — `git show b5a6ddc^:apps/polaris-cli/src/commands/topics/isolate.ts`
    // has it intact for whoever wires isolation into the runtime.
  };
}

const runTopicsIsolate = buildTopicsIsolateRunner();

/**
 * PostgreSQL's `unique_violation` error code is `23505`. The Kysely
 * error wraps the underlying `pg` `DatabaseError`, which surfaces the
 * code via the `code` property.
 */

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

/**
 * Operational instructions returned alongside the activation. Mirrors
 * the producer-first / consumer-second sequence from the cutover
 * runbook so the CLI output stays self-contained.
 */
