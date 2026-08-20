/**
 * Arranging project configuration in tests.
 *
 * Every write goes through `setProjectConfigValueWithAudit` — the same
 * transaction `polaris config set` and the admin panel produce — rather than
 * inserting rows directly. A helper that wrote raw INSERTs would let a test
 * arrange a state the production write path cannot actually produce: values
 * with no audit row, no version bump, and no `NOTIFY`. Tests would then pass
 * against arrangements that never occur, which is worse than having no helper.
 *
 * It is deliberately small. `tests/integration/project-config.test.ts` is its
 * first caller; the per-service cutovers are the rest.
 */

import {
  invalidateProjectConfigWithAudit,
  listProjectConfig,
  type ProjectConfigRow,
  setProjectConfigValueWithAudit,
} from "@polaris/persistence-control-plane";
import type { Database } from "@polaris/persistence-postgres";
import type { PolarisEnvironment } from "@polaris/runtime-environments";
import type { Kysely } from "kysely";

export interface SeedScope {
  readonly db: Kysely<Database>;
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
}

export interface SeedValue {
  readonly namespace: string;
  readonly configKey: string;
  readonly value: unknown;
  /** When true, `value` is stored as a secret and must be a string. */
  readonly isSecret?: boolean;
}

/**
 * Audit identity for seeded values.
 *
 * `migration` rather than a fake operator: a test's rows should be
 * distinguishable from an operator's in any database a human later inspects,
 * and it reuses the vocabulary `audit_records` already defines.
 */
function seedAudit(sequence: number) {
  return {
    auditId: `polaris_aud_seed${String(sequence)}${String(process.pid)}`,
    actorSource: "migration" as const,
    actorLabel: "test-seed",
    reason: "seeded by a test harness",
    occurredAt: new Date(),
  };
}

let counter = 0;

/** Set one configuration value, through the production write path. */
export async function seedProjectConfigValue(scope: SeedScope, value: SeedValue): Promise<void> {
  counter += 1;
  await setProjectConfigValueWithAudit(scope.db, seedAudit(counter), {
    projectId: scope.projectId,
    environment: scope.environment,
    namespace: value.namespace,
    configKey: value.configKey,
    value: value.value,
    isSecret: value.isSecret === true,
  });
}

/** Set several values in one call. Sequential, so version bumps are ordered. */
export async function seedProjectConfig(
  scope: SeedScope,
  values: readonly SeedValue[],
): Promise<void> {
  for (const value of values) {
    await seedProjectConfigValue(scope, value);
  }
}

/** Read back what a scope currently holds, for assertions. */
export async function readProjectConfig(scope: SeedScope): Promise<readonly ProjectConfigRow[]> {
  return listProjectConfig(scope.db, {
    projectId: scope.projectId,
    environment: scope.environment,
  });
}

/**
 * Force every replica to drop its cache for a scope.
 *
 * Useful when a test rotates something behind a secret reference, where the
 * stored value does not change and so nothing else would signal the fleet.
 */
export async function invalidateProjectConfigForTest(scope: SeedScope): Promise<void> {
  counter += 1;
  await invalidateProjectConfigWithAudit(scope.db, seedAudit(counter), {
    projectId: scope.projectId,
    environment: scope.environment,
  });
}

/**
 * Remove a test project's configuration and audit trail.
 *
 * `project_config` rows CASCADE from `projects`, so deleting the project is
 * enough for them — but `audit_records` does not, and a suite that seeds on
 * every run would otherwise leave a growing trail behind.
 */
export async function cleanupProjectConfig(scope: SeedScope): Promise<void> {
  await scope.db.deleteFrom("audit_records").where("project_id", "=", scope.projectId).execute();
  await scope.db.deleteFrom("project_config").where("project_id", "=", scope.projectId).execute();
  await scope.db
    .deleteFrom("project_config_versions")
    .where("project_id", "=", scope.projectId)
    .execute();
}
