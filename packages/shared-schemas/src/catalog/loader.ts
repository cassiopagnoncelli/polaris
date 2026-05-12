import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type CatalogEntry,
  type CatalogEntryFile,
  type SchemaBinding,
  catalogEntryFileSchema,
} from "./types.js";

/**
 * In-memory event catalog.
 *
 * The catalog reads YAML lifecycle metadata from `catalog/events/**` and
 * merges in Zod property schemas supplied programmatically through
 * {@link SchemaBinding}s. YAML is the source of truth for lifecycle
 * (`active`/`deprecated`, `sunset_at`) and human metadata; Zod schemas
 * stay in TypeScript so type-checking catches breakage at compile time.
 *
 * Why split YAML from TS:
 *   - YAML is the operator-friendly surface for governance changes
 *     (deprecate v1, set a sunset date, hand off ownership).
 *   - Zod schemas are code, exactly as `01-event-contract.md` requires.
 *     They never live in YAML.
 *   - Per `10-sdk-standards.md`, the SDK distributions must not bundle
 *     this catalog. SDKs import only the envelope; ingesters import the
 *     catalog and call `loadCatalog` at startup.
 */
export class EventCatalog {
  private readonly entries: Map<string, CatalogEntry>;

  constructor(entries: readonly CatalogEntry[]) {
    this.entries = new Map();
    for (const entry of entries) {
      const key = catalogKey(entry.name, entry.schema_version);
      if (this.entries.has(key)) {
        throw new Error(`Duplicate catalog entry for ${entry.name} v${entry.schema_version}`);
      }
      this.entries.set(key, entry);
    }
  }

  /** Return the entry for an exact (event, schema_version) pair. */
  getEntry(event: string, schemaVersion: number): CatalogEntry | undefined {
    return this.entries.get(catalogKey(event, schemaVersion));
  }

  /** Return every version registered for an event, sorted ascending. */
  getVersions(event: string): CatalogEntry[] {
    const matches: CatalogEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.name === event) matches.push(entry);
    }
    return matches.sort((a, b) => a.schema_version - b.schema_version);
  }

  /** Active versions only — these accept new producer traffic. */
  getActiveVersions(event: string): CatalogEntry[] {
    return this.getVersions(event).filter((entry) => entry.lifecycle === "active");
  }

  /**
   * Versions that are deprecated but still inside their sunset window.
   * The ingester continues to validate these; after the sunset moment
   * passes, callers should treat them as sunset (see {@link isSunset}).
   */
  getDeprecatedVersions(event: string, now: Date = new Date()): CatalogEntry[] {
    return this.getVersions(event).filter(
      (entry) => entry.lifecycle === "deprecated" && !isSunsetAt(entry.sunset_at, now),
    );
  }

  /**
   * True when an entry's `sunset_at` has passed. Returns false for active
   * entries (no `sunset_at`) and for deprecated entries still in window.
   * Callers consult this to emit the `schema_version_sunset` reason code.
   */
  isSunset(event: string, schemaVersion: number, now: Date = new Date()): boolean {
    const entry = this.getEntry(event, schemaVersion);
    if (!entry) return false;
    return isSunsetAt(entry.sunset_at, now);
  }

  /** True when no version exists for the event/version combination. */
  isUnknownVersion(event: string, schemaVersion: number): boolean {
    return !this.entries.has(catalogKey(event, schemaVersion));
  }

  /** Iterate every entry in the catalog (used by CLI inspection commands). */
  list(): CatalogEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => {
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      return a.schema_version - b.schema_version;
    });
  }

  /** Unique event names known to the catalog. */
  listEventNames(): string[] {
    const set = new Set<string>();
    for (const entry of this.entries.values()) set.add(entry.name);
    return Array.from(set).sort();
  }
}

function catalogKey(event: string, schemaVersion: number): string {
  return `${event}@${schemaVersion}`;
}

function isSunsetAt(sunsetAt: string | undefined, now: Date): boolean {
  if (!sunsetAt) return false;
  const sunsetMs = Date.parse(sunsetAt);
  if (Number.isNaN(sunsetMs)) return false;
  return now.getTime() >= sunsetMs;
}

/**
 * Build a catalog from in-memory pieces. Useful in tests and for tooling
 * that has already loaded YAML out-of-band.
 */
export function buildCatalog(
  entries: readonly CatalogEntryFile[],
  bindings: readonly SchemaBinding[],
): EventCatalog {
  const bindingIndex = new Map<string, SchemaBinding>();
  for (const binding of bindings) {
    bindingIndex.set(catalogKey(binding.event, binding.schema_version), binding);
  }

  const merged: CatalogEntry[] = entries.map((entry) => {
    const key = catalogKey(entry.name, entry.schema_version);
    const binding = bindingIndex.get(key);
    if (!binding) {
      throw new Error(
        `Catalog YAML entry ${entry.name} v${entry.schema_version} has no Zod schema binding`,
      );
    }
    return { ...entry, propertiesSchema: binding.propertiesSchema };
  });

  for (const binding of bindings) {
    const hasYaml = entries.some(
      (entry) => entry.name === binding.event && entry.schema_version === binding.schema_version,
    );
    if (!hasYaml) {
      throw new Error(
        `Schema binding ${binding.event} v${binding.schema_version} has no catalog YAML entry`,
      );
    }
  }

  return new EventCatalog(merged);
}

/**
 * Recursively read every `.yaml`/`.yml` file under the given directory
 * and parse it as a {@link CatalogEntryFile}. Symlinks are followed.
 */
export function loadCatalogYamlFromDir(catalogRoot: string): CatalogEntryFile[] {
  const files = collectYamlFiles(catalogRoot);
  const seen = new Map<string, string>();
  const entries: CatalogEntryFile[] = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const raw = parseYaml(text);
    const parsed = catalogEntryFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid catalog entry at ${file}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const key = catalogKey(parsed.data.name, parsed.data.schema_version);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`Duplicate catalog YAML entries for ${key}: ${previous} and ${file}`);
    }
    seen.set(key, file);
    entries.push(parsed.data);
  }

  return entries;
}

/**
 * High-level helper: read YAML from disk and join with the provided
 * bindings. Throws if any YAML entry is missing a binding or vice versa.
 */
export function loadCatalogFromDir(
  catalogRoot: string,
  bindings: readonly SchemaBinding[],
): EventCatalog {
  const entries = loadCatalogYamlFromDir(catalogRoot);
  return buildCatalog(entries, bindings);
}

function collectYamlFiles(root: string): string[] {
  const results: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const stats = statSync(current);
    if (stats.isFile()) {
      if (current.endsWith(".yaml") || current.endsWith(".yml")) results.push(current);
      continue;
    }
    if (!stats.isDirectory()) continue;

    for (const child of readdirSync(current)) {
      if (child.startsWith(".")) continue;
      stack.push(join(current, child));
    }
  }

  return results.sort();
}
