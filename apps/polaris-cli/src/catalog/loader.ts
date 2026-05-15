/**
 * Filesystem loader for the projects/sources catalog.
 *
 * The catalog lives at the repository root under `catalog/`:
 *
 *   catalog/
 *     projects/
 *       <project_id>.yaml
 *     sources/
 *       <project_id>/
 *         <source_id>.yaml
 *
 * This loader walks both trees, parses each file as YAML (using the same
 * `yaml` parser that `@polaris/shared-schemas` already brings into the
 * workspace), validates it with the Zod schemas in `./types.js`, and returns
 * a normalized `LoadedCatalog`. It also enforces structural rules that don't
 * fit in a single-file Zod schema:
 *
 *   - filename matches `project_id` / `source_id`
 *   - source's parent directory equals the source's `project_id`
 *   - every source's `project_id` is declared in `catalog/projects/`
 *   - no duplicate IDs
 *
 * The loader does NOT touch PostgreSQL — that's the sync command's job. Tests
 * exercise it directly against a temp directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { UsageError } from "../errors.js";
import {
  type LoadedCatalog,
  type ProjectFile,
  projectFileSchema,
  type SourceFile,
  sourceFileSchema,
} from "./types.js";

export interface LoadCatalogOptions {
  /** Repository root. The loader resolves `catalog/projects` / `catalog/sources` underneath. */
  readonly root: string;
}

/**
 * Read every YAML file under `<root>/catalog/projects/` and
 * `<root>/catalog/sources/<project_id>/`, validate them, and cross-check the
 * source -> project relationship.
 *
 * Throws `UsageError` (exit code 2) on any structural issue so the CLI surfaces
 * a clear, non-stack-trace message.
 */
export function loadCatalog(options: LoadCatalogOptions): LoadedCatalog {
  const projectsDir = join(options.root, "catalog", "projects");
  const sourcesDir = join(options.root, "catalog", "sources");

  const projects = loadProjects(projectsDir);
  const projectIndex = new Map<string, ProjectFile>();
  for (const project of projects) {
    projectIndex.set(project.project_id, project);
  }

  const sources = loadSources(sourcesDir, projectIndex);

  return {
    root: options.root,
    projects,
    sources,
  };
}

function loadProjects(projectsDir: string): ProjectFile[] {
  if (!existsAsDir(projectsDir)) {
    return [];
  }
  const files = listYamlFiles(projectsDir);
  const seen = new Map<string, string>();
  const entries: ProjectFile[] = [];

  for (const file of files) {
    const data = readYaml(file);
    const parsed = projectFileSchema.safeParse(data);
    if (!parsed.success) {
      throw failedParse(file, parsed.error);
    }
    const project = parsed.data;
    const fileSlug = stripYamlExt(basename(file));
    if (project.project_id !== fileSlug) {
      throw new UsageError(
        `catalog project ${file}: project_id "${project.project_id}" does not match filename "${fileSlug}.yaml"`,
      );
    }
    const previous = seen.get(project.project_id);
    if (previous !== undefined) {
      throw new UsageError(
        `duplicate project_id "${project.project_id}" in ${previous} and ${file}`,
      );
    }
    seen.set(project.project_id, file);
    entries.push(project);
  }

  entries.sort((a, b) => a.project_id.localeCompare(b.project_id));
  return entries;
}

function loadSources(
  sourcesDir: string,
  projectIndex: ReadonlyMap<string, ProjectFile>,
): SourceFile[] {
  if (!existsAsDir(sourcesDir)) {
    return [];
  }

  const entries: SourceFile[] = [];
  const seen = new Map<string, string>();

  for (const child of readdirSync(sourcesDir).sort()) {
    if (child.startsWith(".")) continue;
    const projectDir = join(sourcesDir, child);
    if (!existsAsDir(projectDir)) continue;

    if (!projectIndex.has(child)) {
      throw new UsageError(
        `catalog source directory ${projectDir}: project "${child}" is not declared under catalog/projects/`,
      );
    }

    const files = listYamlFiles(projectDir);
    for (const file of files) {
      const data = readYaml(file);
      const parsed = sourceFileSchema.safeParse(data);
      if (!parsed.success) {
        throw failedParse(file, parsed.error);
      }
      const source = parsed.data;

      if (source.project_id !== child) {
        throw new UsageError(
          `catalog source ${file}: project_id "${source.project_id}" does not match parent directory "${child}"`,
        );
      }

      const fileSlug = stripYamlExt(basename(file));
      if (source.source_id !== fileSlug) {
        throw new UsageError(
          `catalog source ${file}: source_id "${source.source_id}" does not match filename "${fileSlug}.yaml"`,
        );
      }

      const key = `${source.project_id}/${source.source_id}`;
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new UsageError(`duplicate source "${key}" in ${previous} and ${file}`);
      }
      seen.set(key, file);
      entries.push(source);
    }
  }

  entries.sort((a, b) => {
    if (a.project_id !== b.project_id) return a.project_id.localeCompare(b.project_id);
    return a.source_id.localeCompare(b.source_id);
  });
  return entries;
}

/** Convert a Zod issue list into a CLI-facing `UsageError`. */
function failedParse(file: string, error: z.ZodError): UsageError {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
  return new UsageError(`catalog entry ${file} failed validation:\n${issues}`);
}

function listYamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const child of readdirSync(dir).sort()) {
    if (child.startsWith(".")) continue;
    const full = join(dir, child);
    const stats = statSync(full);
    if (!stats.isFile()) continue;
    if (child.endsWith(".yaml") || child.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out;
}

function readYaml(file: string): unknown {
  const text = readFileSync(file, "utf8");
  try {
    return parseYaml(text);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new UsageError(`catalog entry ${file} is not valid YAML: ${reason}`);
  }
}

function stripYamlExt(name: string): string {
  if (name.endsWith(".yaml")) return name.slice(0, -".yaml".length);
  if (name.endsWith(".yml")) return name.slice(0, -".yml".length);
  return name;
}

function existsAsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
