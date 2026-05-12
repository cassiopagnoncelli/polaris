/**
 * Sync planner: compare the file-backed catalog with PostgreSQL rows and
 * decide which inserts/updates need to happen.
 *
 * The planner is pure — it takes already-loaded catalog entries and
 * already-fetched DB rows and produces a `SyncPlan`. Applying the plan
 * (writing rows back to PostgreSQL) is the responsibility of the
 * commands themselves.
 *
 * Plans are diff-based: `to_create` rows have no DB peer, `to_update` rows
 * differ on at least one non-timestamp column. Catalog absence does NOT
 * mean delete in v1 — destruction is out of scope here and would belong to
 * a separate `--prune` flag.
 */
import type { Environment, ProjectFile, SourceFile } from "./types.js";

export type SyncAction = "create" | "update" | "noop";

export interface ProjectDiffRow {
  readonly project_id: string;
  readonly action: SyncAction;
  readonly desired: ProjectFile;
  readonly current: ProjectRow | undefined;
}

export interface SourceDiffRow {
  readonly project_id: string;
  readonly source_id: string;
  readonly action: SyncAction;
  readonly desired: SourceFile;
  readonly current: SourceRow | undefined;
}

export interface ProjectRow {
  readonly project_id: string;
  readonly display_name: string;
  readonly owner: string;
  readonly description: string;
  readonly status: string;
}

export interface SourceRow {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly owner: string;
  readonly description: string;
  readonly runtime: string;
  readonly allowed_environments: readonly string[];
  readonly status: string;
}

export interface ProjectsSyncPlan {
  readonly to_create: readonly ProjectDiffRow[];
  readonly to_update: readonly ProjectDiffRow[];
  readonly unchanged: readonly ProjectDiffRow[];
}

export interface SourcesSyncPlan {
  readonly to_create: readonly SourceDiffRow[];
  readonly to_update: readonly SourceDiffRow[];
  readonly unchanged: readonly SourceDiffRow[];
}

/**
 * Diff catalog projects against the current `projects` rows.
 */
export function planProjectsSync(
  desired: readonly ProjectFile[],
  current: readonly ProjectRow[],
): ProjectsSyncPlan {
  const currentIndex = new Map<string, ProjectRow>();
  for (const row of current) currentIndex.set(row.project_id, row);

  const to_create: ProjectDiffRow[] = [];
  const to_update: ProjectDiffRow[] = [];
  const unchanged: ProjectDiffRow[] = [];

  for (const project of desired) {
    const existing = currentIndex.get(project.project_id);
    if (existing === undefined) {
      to_create.push({
        project_id: project.project_id,
        action: "create",
        desired: project,
        current: undefined,
      });
      continue;
    }
    if (projectEquals(project, existing)) {
      unchanged.push({
        project_id: project.project_id,
        action: "noop",
        desired: project,
        current: existing,
      });
    } else {
      to_update.push({
        project_id: project.project_id,
        action: "update",
        desired: project,
        current: existing,
      });
    }
  }

  return { to_create, to_update, unchanged };
}

/**
 * Diff catalog sources against the current `sources` rows.
 */
export function planSourcesSync(
  desired: readonly SourceFile[],
  current: readonly SourceRow[],
): SourcesSyncPlan {
  const currentIndex = new Map<string, SourceRow>();
  for (const row of current) currentIndex.set(sourceKey(row.project_id, row.source_id), row);

  const to_create: SourceDiffRow[] = [];
  const to_update: SourceDiffRow[] = [];
  const unchanged: SourceDiffRow[] = [];

  for (const source of desired) {
    const key = sourceKey(source.project_id, source.source_id);
    const existing = currentIndex.get(key);
    if (existing === undefined) {
      to_create.push({
        project_id: source.project_id,
        source_id: source.source_id,
        action: "create",
        desired: source,
        current: undefined,
      });
      continue;
    }
    if (sourceEquals(source, existing)) {
      unchanged.push({
        project_id: source.project_id,
        source_id: source.source_id,
        action: "noop",
        desired: source,
        current: existing,
      });
    } else {
      to_update.push({
        project_id: source.project_id,
        source_id: source.source_id,
        action: "update",
        desired: source,
        current: existing,
      });
    }
  }

  return { to_create, to_update, unchanged };
}

function projectEquals(desired: ProjectFile, current: ProjectRow): boolean {
  return (
    desired.project_id === current.project_id &&
    desired.display_name === current.display_name &&
    desired.owner === current.owner &&
    desired.description === current.description &&
    desired.status === current.status
  );
}

function sourceEquals(desired: SourceFile, current: SourceRow): boolean {
  return (
    desired.project_id === current.project_id &&
    desired.source_id === current.source_id &&
    desired.source_type === current.source_type &&
    desired.owner === current.owner &&
    desired.description === current.description &&
    desired.runtime === current.runtime &&
    desired.status === current.status &&
    arrayEqualsAsSet(desired.allowed_environments, current.allowed_environments)
  );
}

function arrayEqualsAsSet(desired: readonly Environment[], current: readonly string[]): boolean {
  if (desired.length !== current.length) return false;
  const a = [...desired].sort();
  const b = [...current].sort();
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sourceKey(projectId: string, sourceId: string): string {
  return `${projectId}/${sourceId}`;
}
