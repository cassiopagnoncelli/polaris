/**
 * Cold-path snapshot assembly.
 *
 * Two queries per assembly — the namespace's value rows, and the scope's
 * version — plus one secret resolution per secret-flagged row. Everything
 * here runs only on a cache miss or a stale refetch; the hot read path never
 * reaches this module.
 */

import type { Database } from "@polaris/shared-db";
import type { PolarisEnvironment } from "@polaris/shared-environments";
import type { SecretResolver } from "@polaris/shared-secrets";
import type { Kysely } from "kysely";
import { ProjectConfigAssemblyError } from "./errors.js";
import { isSecret, Secret } from "./secret-box.js";
import type { ProjectConfigKey, ProjectConfigSnapshot } from "./types.js";

/** Reads the version for one scope. `0n` when the scope has never been written. */
export async function readVersion(
  db: Kysely<Database>,
  projectId: string,
  environment: PolarisEnvironment,
): Promise<bigint> {
  const row = await db
    .selectFrom("project_config_versions")
    .select("version")
    .where("project_id", "=", projectId)
    .where("environment", "=", environment)
    .executeTakeFirst();
  return row === undefined ? 0n : BigInt(row.version);
}

/**
 * Reads versions for many scopes in ONE query — the sweep's whole point.
 *
 * Scopes with no row are absent from the result; the caller treats absence as
 * version `0n`.
 */
export async function readVersions(
  db: Kysely<Database>,
  scopes: readonly (readonly [string, PolarisEnvironment])[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (scopes.length === 0) return out;

  const rows = await db
    .selectFrom("project_config_versions")
    .select(["project_id", "environment", "version"])
    .where((eb) =>
      eb.or(
        scopes.map(([projectId, environment]) =>
          eb.and([eb("project_id", "=", projectId), eb("environment", "=", environment)]),
        ),
      ),
    )
    .execute();

  for (const row of rows) {
    out.set(scopeKey(row.project_id, row.environment), BigInt(row.version));
  }
  return out;
}

/** Cache key for a `(project, environment)` scope. NUL-joined; ids forbid NUL. */
export function scopeKey(projectId: string, environment: string): string {
  return `${projectId}\0${environment}`;
}

/** Cache key for one namespace within a scope. */
export function snapshotKey(key: ProjectConfigKey): string {
  return `${key.projectId}\0${key.environment}\0${key.namespace}`;
}

/**
 * Assemble one namespace slice.
 *
 * Reads the VERSION first, then the values — and the order is load-bearing.
 * The two reads are separate statements, so a writer's commit (values and
 * version bump in one transaction) can land between them. Version-first can
 * only UNDER-label: the snapshot carries old-version + possibly-newer values,
 * so the write's own notification (or the sweep) sees `new > cached` and
 * marks it stale — one redundant refetch, then correct.
 *
 * Values-first can OVER-label: old values stamped with the new version. The
 * notification then compares `new <= cached` and leaves the entry fresh, the
 * sweep agrees with it, and the stale values survive until the next unrelated
 * write. An earlier revision of this function had exactly that order, with a
 * comment arguing it was the safe one.
 */
export async function assembleSnapshot(input: {
  readonly db: Kysely<Database>;
  readonly secrets: SecretResolver;
  readonly key: ProjectConfigKey;
  readonly now: () => Date;
}): Promise<ProjectConfigSnapshot> {
  const { db, secrets, key } = input;
  try {
    const version = await readVersion(db, key.projectId, key.environment);

    const rows = await db
      .selectFrom("project_config")
      .select(["config_key", "value", "is_secret_ref"])
      .where("project_id", "=", key.projectId)
      .where("environment", "=", key.environment)
      .where("namespace", "=", key.namespace)
      .execute();

    const values: Record<string, unknown> = {};
    for (const row of rows) {
      if (row.is_secret_ref) {
        // The stored value is a `provider:ref` string, enforced by the
        // `project_config_secret_ref_shape` CHECK.
        const resolved = await secrets.resolve(row.value as string);
        values[row.config_key] = new Secret(resolved);
      } else {
        values[row.config_key] = row.value;
      }
    }

    return createSnapshot({
      key,
      version,
      values,
      resolvedAt: input.now().getTime(),
    });
  } catch (err) {
    throw new ProjectConfigAssemblyError(key.projectId, key.environment, key.namespace, {
      cause: err,
    });
  }
}

/** Builds a frozen snapshot with a redacting `toJSON`. */
export function createSnapshot(input: {
  readonly key: ProjectConfigKey;
  readonly version: bigint;
  readonly values: Record<string, unknown>;
  readonly resolvedAt: number;
}): ProjectConfigSnapshot {
  const values = Object.freeze({ ...input.values });
  const hasSecret = Object.values(values).some(isSecret);

  const snapshot: ProjectConfigSnapshot & { readonly hasSecret: boolean } = {
    projectId: input.key.projectId,
    environment: input.key.environment,
    namespace: input.key.namespace,
    version: input.version,
    values,
    resolvedAt: input.resolvedAt,
    hasSecret,
    toJSON(): unknown {
      // Secret.toJSON already redacts, but mapping explicitly means the
      // redaction does not depend on JSON.stringify's willingness to call it.
      const redacted: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(values)) {
        redacted[name] = isSecret(value) ? "[redacted]" : value;
      }
      return {
        projectId: input.key.projectId,
        environment: input.key.environment,
        namespace: input.key.namespace,
        version: input.version.toString(),
        resolvedAt: input.resolvedAt,
        values: redacted,
      };
    },
  };
  return Object.freeze(snapshot);
}

/** Whether a snapshot holds any resolved secret, and so has a refresh deadline. */
export function snapshotHasSecret(snapshot: ProjectConfigSnapshot): boolean {
  return Object.values(snapshot.values).some(isSecret);
}
