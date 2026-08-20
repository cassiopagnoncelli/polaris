/**
 * Audited project-configuration mutations.
 *
 * Each of these is one transaction carrying four writes that must not come
 * apart: the value, the scope's version bump, the `pg_notify` that tells every
 * replica to drop its cache, and the audit row. A partial application of that
 * set is a live incident — a version bumped without values changing makes
 * every replica refetch for nothing; values changed without a bump leaves the
 * fleet serving stale configuration until the next unrelated write.
 *
 * Two gates run BEFORE any write, so a rejected call leaves no trace:
 *
 *   1. **Mapping semantics.** `project_config.value` is `jsonb`, so the
 *      "PostgreSQL has nowhere to put a field map" guarantee no longer holds
 *      structurally. It holds because of this check.
 *   2. **The mask as a value.** Reads return `[redacted]` for a secret, so a
 *      surface that round-trips a read into a write would store that string
 *      as the credential.
 *
 * A different second gate used to sit here, rejecting anything but a
 * `<provider>:<ref>` pointer on a secret-typed key. It is gone with the move to
 * stored secrets: plaintext on a secret key is now the expected input, not the
 * error case. What replaced it is on the way OUT rather than the way in — the
 * audit snapshots below mask secret values, because an `audit_records` row
 * outlives the config row, gets exported, and is read by more people.
 *
 * @see ../queries/project-config.ts
 * @see docs/implementation/project-config-plan.md §3.5, §4.4
 */

import {
  assertNoMappingSemantics,
  isMaskedSecret,
  maskIfSecret,
  SECRET_MASK,
} from "@polaris/tenancy-control-plane";
import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  bumpProjectConfigVersion,
  deleteProjectConfigValue,
  findProjectConfigValue,
  notifyProjectConfigChanged,
  type ProjectConfigRow,
  upsertProjectConfigValue,
} from "../queries/project-config.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

/**
 * Audit snapshot. Records that a secret changed, never what it changed to.
 *
 * `is_secret` is retained precisely so a reader can tell "the value is
 * `[redacted]`" from "the value is literally the string `[redacted]`", and so
 * a key's transition INTO or OUT OF secret status is itself auditable.
 */
export interface ProjectConfigAuditSnapshot {
  readonly project_id: string;
  readonly environment: string;
  readonly namespace: string;
  readonly config_key: string;
  readonly value: unknown;
  readonly is_secret: boolean;
}

/**
 * Build a `before` snapshot from a stored row.
 *
 * The row arrives already masked — `toRow` in ../queries/project-config.ts is
 * the choke point — so this is a projection, not a redaction. The `after`
 * snapshots below are the ones that must mask, because they are built from
 * caller input rather than from a read.
 */
export function toProjectConfigSnapshot(row: ProjectConfigRow): ProjectConfigAuditSnapshot {
  return {
    project_id: row.project_id,
    environment: row.environment,
    namespace: row.namespace,
    config_key: row.config_key,
    value: row.value,
    is_secret: row.is_secret,
  };
}

/** Raised when a write would store the redaction placeholder as a real value. */
export class MaskedSecretWriteError extends Error {
  public readonly configKey: string;

  constructor(configKey: string) {
    super(
      `"${configKey}" was given the literal string ${SECRET_MASK}, which is what ` +
        "Polaris shows INSTEAD of a secret value. This usually means a masked read " +
        "was submitted back as a write. Pass the real value, or leave the key alone.",
    );
    this.name = "MaskedSecretWriteError";
    this.configKey = configKey;
  }
}

export interface SetProjectConfigInput {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly namespace: string;
  readonly configKey: string;
  readonly value: unknown;
  readonly isSecret: boolean;
}

/**
 * Set (or replace) one configuration value.
 *
 * Always `applied: true` — unlike the destination toggles, re-setting a value
 * to what it already is still bumps the version. Cheap, and it keeps the write
 * path free of a comparison it cannot make honestly: `before` is masked for a
 * secret key, so "did this change?" is unanswerable here without a second
 * unmasked read of exactly the data this module refuses to handle.
 */
export async function setProjectConfigValueWithAudit(
  db: Kysely<Database>,
  audit: AuditContext,
  input: SetProjectConfigInput,
): Promise<MutationOutcome> {
  assertNoMappingSemantics([input.configKey], "project configuration");

  // Refuse the mask itself. Every read path returns `[redacted]` for a secret,
  // so any surface that round-trips a read into a write — a form pre-filled
  // from a list, a script that pipes `config list` back into `config set` —
  // would otherwise store that literal string as the credential. The delivery
  // would then fail at the vendor with an auth error pointing nowhere near the
  // cause. Cheap to check, and there is no legitimate value it rejects.
  if (isMaskedSecret(input.value)) {
    throw new MaskedSecretWriteError(input.configKey);
  }

  const before = await findProjectConfigValue(db, input);

  return withAudit(
    db,
    audit,
    {
      action: "config.set",
      targetType: "project_config",
      targetId: `${input.projectId}/${input.environment}/${input.namespace}/${input.configKey}`,
      projectId: input.projectId,
      environment: input.environment,
      before: before === undefined ? null : toProjectConfigSnapshot(before),
      after: {
        project_id: input.projectId,
        environment: input.environment,
        namespace: input.namespace,
        config_key: input.configKey,
        // Built from caller input, so this is the redaction — unlike `before`,
        // which came back masked from the query layer. Without it, every
        // `polaris config set --secret` would write the credential into
        // `audit_records` in cleartext.
        value: maskIfSecret(input.value, input.isSecret),
        is_secret: input.isSecret,
      } satisfies ProjectConfigAuditSnapshot,
    },
    async (trx) => {
      await upsertProjectConfigValue(trx, {
        projectId: input.projectId,
        environment: input.environment,
        namespace: input.namespace,
        configKey: input.configKey,
        value: input.value,
        isSecret: input.isSecret,
        updatedBy: audit.actorLabel,
        updatedAt: audit.occurredAt,
      });
      const version = await bumpProjectConfigVersion(
        trx,
        input.projectId,
        input.environment,
        audit.occurredAt,
      );
      await notifyProjectConfigChanged(trx, input.projectId, input.environment, version);
      return true;
    },
  );
}

export interface UnsetProjectConfigInput {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly namespace: string;
  readonly configKey: string;
}

/**
 * Remove one configuration value, reverting the key to its component default.
 *
 * `applied: false` when the key did not exist — no audit row, matching the
 * "the log records transitions, not clicks" rule in `audited.ts`.
 */
export async function unsetProjectConfigValueWithAudit(
  db: Kysely<Database>,
  audit: AuditContext,
  input: UnsetProjectConfigInput,
): Promise<MutationOutcome> {
  const before = await findProjectConfigValue(db, input);

  return withAudit(
    db,
    audit,
    {
      action: "config.unset",
      targetType: "project_config",
      targetId: `${input.projectId}/${input.environment}/${input.namespace}/${input.configKey}`,
      projectId: input.projectId,
      environment: input.environment,
      before: before === undefined ? null : toProjectConfigSnapshot(before),
      after: null,
    },
    async (trx) => {
      const deleted = await deleteProjectConfigValue(trx, input);
      if (!deleted) return false;
      const version = await bumpProjectConfigVersion(
        trx,
        input.projectId,
        input.environment,
        audit.occurredAt,
      );
      await notifyProjectConfigChanged(trx, input.projectId, input.environment, version);
      return true;
    },
  );
}

export interface InvalidateProjectConfigInput {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

/**
 * Bump the version and notify without changing any value.
 *
 * The escape hatch for changes version-watching cannot see. It used to have a
 * routine caller — a Vault rotation left `project_config` untouched, so the
 * version never moved and replicas served a revoked credential until the
 * secret deadline expired. Stored secrets removed that case entirely: a secret
 * changes only by a write here, which bumps the version itself.
 *
 * What remains is the irregular case, and it is worth keeping for: someone
 * edited `project_config` with direct SQL, bypassing this module and its
 * version bump. Recovery is otherwise a fleet restart.
 */
export async function invalidateProjectConfigWithAudit(
  db: Kysely<Database>,
  audit: AuditContext,
  input: InvalidateProjectConfigInput,
): Promise<MutationOutcome> {
  return withAudit(
    db,
    audit,
    {
      action: "config.invalidate",
      targetType: "project_config",
      targetId: `${input.projectId}/${input.environment}`,
      projectId: input.projectId,
      environment: input.environment,
      before: null,
      after: null,
    },
    async (trx) => {
      const version = await bumpProjectConfigVersion(
        trx,
        input.projectId,
        input.environment,
        audit.occurredAt,
      );
      await notifyProjectConfigChanged(trx, input.projectId, input.environment, version);
      return true;
    },
  );
}
