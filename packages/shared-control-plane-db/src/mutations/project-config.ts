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
 *   2. **Plaintext secrets.** A key marked `is_secret_ref` must carry a
 *      `<provider>:<ref>` pointer. The database CHECK enforces the shape as a
 *      last line of defence; this produces the readable error before the
 *      operator's credential is anywhere near a query log.
 *
 * @see ../queries/project-config.ts
 * @see docs/implementation/project-config-plan.md §3.5, §4.4
 */

import { assertNoMappingSemantics } from "@polaris/shared-control-plane";
import type { Database } from "@polaris/shared-db";
import { parseSecretReference } from "@polaris/shared-secrets";
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

/** Audit snapshot. Carries the secret REF when one is involved, never a value. */
export interface ProjectConfigAuditSnapshot {
  readonly project_id: string;
  readonly environment: string;
  readonly namespace: string;
  readonly config_key: string;
  readonly value: unknown;
  readonly is_secret_ref: boolean;
}

export function toProjectConfigSnapshot(row: ProjectConfigRow): ProjectConfigAuditSnapshot {
  return {
    project_id: row.project_id,
    environment: row.environment,
    namespace: row.namespace,
    config_key: row.config_key,
    value: row.value,
    is_secret_ref: row.is_secret_ref,
  };
}

/** Raised when a secret-typed key is given something that is not a reference. */
export class PlaintextSecretError extends Error {
  public readonly configKey: string;

  constructor(configKey: string) {
    super(
      `"${configKey}" is a secret-typed key and accepts only a provider reference ` +
        `(e.g. "vault:polaris/production/storefront/meta-capi"). ` +
        "PostgreSQL never stores plaintext secrets.",
    );
    this.name = "PlaintextSecretError";
    this.configKey = configKey;
  }
}

export interface SetProjectConfigInput {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
  readonly namespace: string;
  readonly configKey: string;
  readonly value: unknown;
  readonly isSecretRef: boolean;
}

/**
 * Set (or replace) one configuration value.
 *
 * Always `applied: true` — unlike the destination toggles, re-setting a value
 * to what it already is still bumps the version. That is deliberate: an
 * operator who re-saves a value after rotating the credential BEHIND a
 * reference needs the fleet to notice, and the store cannot tell that case
 * from a no-op by comparing the reference alone.
 */
export async function setProjectConfigValueWithAudit(
  db: Kysely<Database>,
  audit: AuditContext,
  input: SetProjectConfigInput,
): Promise<MutationOutcome> {
  assertNoMappingSemantics([input.configKey], "project configuration");

  if (input.isSecretRef) {
    if (typeof input.value !== "string") throw new PlaintextSecretError(input.configKey);
    try {
      parseSecretReference(input.value);
    } catch {
      // Re-thrown as PlaintextSecretError rather than surfaced raw. Two
      // reasons: callers catch ONE type for "this secret key got something
      // that is not a reference" (the CLI turns it into a usage error rather
      // than a stack trace), and the message here is guaranteed not to echo
      // the input — which, on this particular path, is probably a live
      // credential the operator pasted by mistake.
      throw new PlaintextSecretError(input.configKey);
    }
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
        value: input.value,
        is_secret_ref: input.isSecretRef,
      } satisfies ProjectConfigAuditSnapshot,
    },
    async (trx) => {
      await upsertProjectConfigValue(trx, {
        projectId: input.projectId,
        environment: input.environment,
        namespace: input.namespace,
        configKey: input.configKey,
        value: input.value,
        isSecretRef: input.isSecretRef,
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
 * The escape hatch for the one case version-watching cannot see: an operator
 * rotated a credential in Vault, so `project_config` is unchanged, the version
 * never moves, and every replica would keep its resolved plaintext until the
 * 5-minute secret deadline expires. This forces the drop immediately.
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
