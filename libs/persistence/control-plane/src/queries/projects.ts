/**
 * Repository helpers for the `projects` and `sources` tables.
 *
 * These helpers are written against the typed Kysely surface in
 * `@polaris/persistence-postgres`. They expose plain async functions so the command
 * layer can stay focused on rendering and orchestration.
 *
 * No business logic lives here — every helper is a single query. The sync
 * planner in `../catalog/sync.ts` decides what to call.
 */
import type {
  Database,
  Environment,
  ProjectStatus,
  SourceRuntime,
  SourceStatus,
  SourceType,
} from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";
/**
 * Row and input shapes.
 *
 * Declared here rather than imported from the CLI's catalog layer: this
 * package holds the database contract, and it should not know that the rows
 * happen to be Zod-inferred from YAML on one of its callers. The catalog's
 * `ProjectFile` / `SourceFile` are structurally compatible, so the CLI passes
 * them straight in.
 */
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

/** Catalog-declared project, as the sync path writes it. */
export interface ProjectFile {
  readonly project_id: string;
  readonly display_name: string;
  readonly owner: string;
  readonly description: string;
  readonly status: ProjectStatus;
}

/** Catalog-declared source, as the sync path writes it. */
export interface SourceFile {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_type: SourceType;
  readonly owner: string;
  readonly description: string;
  readonly runtime: SourceRuntime;
  readonly allowed_environments: readonly Environment[];
  readonly status: SourceStatus;
}

export async function fetchAllProjects(db: Kysely<Database>): Promise<ProjectRow[]> {
  const rows = await db
    .selectFrom("projects")
    .select(["project_id", "display_name", "owner", "description", "status"])
    .orderBy("project_id")
    .execute();
  return rows.map((row) => ({
    project_id: row.project_id,
    display_name: row.display_name,
    owner: row.owner,
    description: row.description,
    status: row.status,
  }));
}

export async function fetchAllSources(db: Kysely<Database>): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom("sources")
    .select([
      "project_id",
      "source_id",
      "source_type",
      "owner",
      "description",
      "runtime",
      "allowed_environments",
      "status",
    ])
    .orderBy("project_id")
    .orderBy("source_id")
    .execute();
  return rows.map((row) => ({
    project_id: row.project_id,
    source_id: row.source_id,
    source_type: row.source_type,
    owner: row.owner,
    description: row.description,
    runtime: row.runtime,
    allowed_environments: row.allowed_environments,
    status: row.status,
  }));
}

export async function fetchSourcesByProject(
  db: Kysely<Database>,
  projectId: string,
): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom("sources")
    .select([
      "project_id",
      "source_id",
      "source_type",
      "owner",
      "description",
      "runtime",
      "allowed_environments",
      "status",
    ])
    .where("project_id", "=", projectId)
    .orderBy("source_id")
    .execute();
  return rows.map((row) => ({
    project_id: row.project_id,
    source_id: row.source_id,
    source_type: row.source_type,
    owner: row.owner,
    description: row.description,
    runtime: row.runtime,
    allowed_environments: row.allowed_environments,
    status: row.status,
  }));
}

export async function fetchSourcesById(
  db: Kysely<Database>,
  sourceId: string,
): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom("sources")
    .select([
      "project_id",
      "source_id",
      "source_type",
      "owner",
      "description",
      "runtime",
      "allowed_environments",
      "status",
    ])
    .where("source_id", "=", sourceId)
    .orderBy("project_id")
    .execute();
  return rows.map((row) => ({
    project_id: row.project_id,
    source_id: row.source_id,
    source_type: row.source_type,
    owner: row.owner,
    description: row.description,
    runtime: row.runtime,
    allowed_environments: row.allowed_environments,
    status: row.status,
  }));
}

export async function insertProject(db: Kysely<Database>, project: ProjectFile): Promise<void> {
  await db
    .insertInto("projects")
    .values({
      project_id: project.project_id,
      display_name: project.display_name,
      owner: project.owner,
      description: project.description,
      status: project.status,
    })
    .execute();
}

export async function updateProject(db: Kysely<Database>, project: ProjectFile): Promise<void> {
  await db
    .updateTable("projects")
    .set({
      display_name: project.display_name,
      owner: project.owner,
      description: project.description,
      status: project.status,
      updated_at: new Date(),
    })
    .where("project_id", "=", project.project_id)
    .execute();
}

export async function insertSource(db: Kysely<Database>, source: SourceFile): Promise<void> {
  await db
    .insertInto("sources")
    .values({
      project_id: source.project_id,
      source_id: source.source_id,
      source_type: source.source_type,
      owner: source.owner,
      description: source.description,
      runtime: source.runtime,
      allowed_environments: source.allowed_environments as Environment[],
      status: source.status,
    })
    .execute();
}

export async function updateSource(db: Kysely<Database>, source: SourceFile): Promise<void> {
  await db
    .updateTable("sources")
    .set({
      source_type: source.source_type,
      owner: source.owner,
      description: source.description,
      runtime: source.runtime,
      allowed_environments: source.allowed_environments as Environment[],
      status: source.status,
      updated_at: new Date(),
    })
    .where("project_id", "=", source.project_id)
    .where("source_id", "=", source.source_id)
    .execute();
}
