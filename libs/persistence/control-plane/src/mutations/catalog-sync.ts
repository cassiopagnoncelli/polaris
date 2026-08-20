/**
 * Audited catalog sync.
 *
 * ## The gap this closes
 *
 * `projects sync` and `sources sync` wrote no audit row. They are the only
 * commands that can change what a project *is* — its owner, its status, which
 * environments a source may emit from — and until now they did it invisibly.
 *
 * ## One row per run, not per row changed
 *
 * A sync that creates two projects and updates forty sources is **one**
 * operator action, taken against one catalog revision. Forty-two audit rows
 * would bury the fact that they were a single `polaris sources sync` and
 * make the log unreadable at exactly the moment someone is trying to work out
 * what changed. So the summary goes in `after`: counts plus the affected ids.
 *
 * `before` carries the counts as they stood, so a reader can see the shape of
 * the change without diffing two catalog revisions by hand.
 *
 * ## Why the whole sync is one transaction
 *
 * A half-applied sync is worse than a failed one: the catalog is the source
 * of truth and Postgres is its materialised mirror, so a partial apply leaves
 * the mirror describing a state no catalog revision ever had. Rolling back
 * means the operator re-runs and gets the same result.
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely, Transaction } from "kysely";

import type { AuditEnvironment } from "../queries/audit-records.js";
import {
  insertProject,
  insertSource,
  type ProjectFile,
  type SourceFile,
  updateProject,
  updateSource,
} from "../queries/projects.js";
import { type AuditContext, type MutationOutcome, withAudit } from "./audited.js";

/** What a planner decided to apply. Mirrors the CLI's sync plan shape. */
export interface CatalogSyncPlan<T> {
  readonly to_create: readonly T[];
  readonly to_update: readonly T[];
}

export interface CatalogSyncOutcome extends MutationOutcome {
  readonly created: number;
  readonly updated: number;
}

async function applySync<T>(
  db: Kysely<Database>,
  plan: CatalogSyncPlan<T>,
  audit: AuditContext,
  spec: {
    action: string;
    targetType: string;
    idOf: (item: T) => string;
    create: (trx: Transaction<Database>, item: T) => Promise<void>;
    update: (trx: Transaction<Database>, item: T) => Promise<void>;
    /** Existing row counts, for the `before` snapshot. */
    existing: { total: number };
  },
): Promise<CatalogSyncOutcome> {
  const created = plan.to_create.map(spec.idOf);
  const updated = plan.to_update.map(spec.idOf);

  // Nothing to do is not an event. A sync that finds the mirror already
  // correct should not add a row saying so — that is how an audit log fills
  // with noise and stops being read.
  if (created.length === 0 && updated.length === 0) {
    return { applied: false, auditId: null, created: 0, updated: 0 };
  }

  const outcome = await withAudit(
    db,
    audit,
    {
      action: spec.action,
      targetType: spec.targetType,
      // The catalog as a whole is the target; individual ids are in `after`.
      targetId: "catalog",
      before: { total: spec.existing.total },
      after: {
        total: spec.existing.total + created.length,
        created_count: created.length,
        updated_count: updated.length,
        created,
        updated,
      },
    },
    async (trx) => {
      for (const item of plan.to_create) await spec.create(trx, item);
      for (const item of plan.to_update) await spec.update(trx, item);
      return true;
    },
  );

  return { ...outcome, created: created.length, updated: updated.length };
}

export async function syncProjectsWithAudit(
  db: Kysely<Database>,
  plan: CatalogSyncPlan<ProjectFile>,
  existing: { total: number },
  audit: AuditContext,
): Promise<CatalogSyncOutcome> {
  return applySync(db, plan, audit, {
    action: "projects.sync",
    targetType: "project",
    idOf: (project) => project.project_id,
    create: (trx, project) => insertProject(trx, project),
    update: (trx, project) => updateProject(trx, project),
    existing,
  });
}

export async function syncSourcesWithAudit(
  db: Kysely<Database>,
  plan: CatalogSyncPlan<SourceFile>,
  existing: { total: number },
  audit: AuditContext,
): Promise<CatalogSyncOutcome> {
  return applySync(db, plan, audit, {
    action: "sources.sync",
    targetType: "source",
    // `<project_id>/<source_id>` — sources are keyed by the pair.
    idOf: (source) => `${source.project_id}/${source.source_id}`,
    create: (trx, source) => insertSource(trx, source),
    update: (trx, source) => updateSource(trx, source),
    existing,
  });
}

/** Re-exported so the audit environment type stays reachable from callers. */
export type { AuditEnvironment };
