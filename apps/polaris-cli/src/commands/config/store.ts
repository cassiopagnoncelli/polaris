/**
 * Store contract for the `polaris config` group.
 *
 * One contract shared by all five verbs, with the Kysely-backed default at the
 * bottom; tests inject an in-memory adapter. The mutating methods delegate
 * straight to the `*WithAudit` functions in `@polaris/shared-control-plane-db`
 * — which own the transaction carrying the value write, the version bump, the
 * `pg_notify`, and the audit row. The CLI deliberately holds no SQL of its
 * own: the admin UI (C5) will call the same functions, and two surfaces that
 * could disagree means one of them is wrong.
 */

import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  fetchAllProjects,
  invalidateProjectConfigWithAudit,
  listProjectConfig,
  type MutationOutcome,
  type ProjectConfigRow,
  readProjectConfigVersion,
  setProjectConfigValueWithAudit,
  unsetProjectConfigValueWithAudit,
} from "../../db/index.js";

/** Audit identity for one config mutation. */
export interface ConfigAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly reason: string;
}

export interface ConfigScope {
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

export interface ConfigStore {
  list(scope: ConfigScope, namespace?: string): Promise<readonly ProjectConfigRow[]>;
  /** Every project id, for validating a whole environment at once. */
  listProjectIds(): Promise<readonly string[]>;
  version(scope: ConfigScope): Promise<bigint>;
  set(
    input: ConfigScope & {
      readonly namespace: string;
      readonly configKey: string;
      readonly value: unknown;
      readonly isSecretRef: boolean;
    },
    audit: ConfigAuditPayload,
  ): Promise<MutationOutcome>;
  unset(
    input: ConfigScope & { readonly namespace: string; readonly configKey: string },
    audit: ConfigAuditPayload,
  ): Promise<MutationOutcome>;
  invalidate(scope: ConfigScope, audit: ConfigAuditPayload): Promise<MutationOutcome>;
  close(): Promise<void>;
}

export interface ConfigHooks {
  readonly openStore?: () => ConfigStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

export function defaultConfigStore(env: NodeJS.ProcessEnv): ConfigStore {
  const handle = connectDb({ env });
  const toAudit = (audit: ConfigAuditPayload) => ({
    auditId: audit.auditId,
    actorSource: audit.actorSource,
    actorLabel: audit.actorLabel,
    occurredAt: audit.occurredAt,
    reason: audit.reason,
  });

  return {
    list: (scope, namespace) =>
      listProjectConfig(handle.db, {
        projectId: scope.projectId,
        environment: scope.environment,
        ...(namespace !== undefined ? { namespace } : {}),
      }),
    listProjectIds: async () => (await fetchAllProjects(handle.db)).map((row) => row.project_id),
    version: (scope) => readProjectConfigVersion(handle.db, scope.projectId, scope.environment),
    set: (input, audit) => setProjectConfigValueWithAudit(handle.db, toAudit(audit), input),
    unset: (input, audit) => unsetProjectConfigValueWithAudit(handle.db, toAudit(audit), input),
    invalidate: (scope, audit) =>
      invalidateProjectConfigWithAudit(handle.db, toAudit(audit), {
        projectId: scope.projectId,
        environment: scope.environment,
      }),
    close: () => handle.close(),
  };
}
