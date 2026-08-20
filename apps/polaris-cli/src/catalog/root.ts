/**
 * Resolve the repository root that the catalog tree lives under.
 *
 * Resolution order, highest priority first:
 *
 *   1. Explicit `POLARIS_CATALOG_ROOT` env var (treated as the repo root,
 *      meaning the loader will look at `<root>/catalog/...`).
 *   2. `--catalog-root <path>` flag passed to the command (handled at the
 *      command layer; this module only exposes the env-var path).
 *   3. Walk up from the current working directory until a directory contains
 *      a `catalog/` subdirectory. This makes the CLI work from anywhere in
 *      the repo without configuration.
 *
 * Throws `UsageError` with a clear message when none of the above resolves to
 * an existing directory containing `catalog/`. CLI commands surface that as
 * exit code 2.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { UsageError } from "../errors.js";

export interface ResolveCatalogRootOptions {
  /** Optional explicit override (typically from a `--catalog-root` flag). */
  readonly explicit?: string | undefined;
  /** Process env. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Starting directory for the upward walk. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

export function resolveCatalogRoot(options: ResolveCatalogRootOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const explicit = trim(options.explicit) ?? trim(env["POLARIS_CATALOG_ROOT"]);
  if (explicit !== undefined) {
    const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!hasCatalogDir(abs)) {
      throw new UsageError(`POLARIS_CATALOG_ROOT="${abs}" does not contain a catalog/ directory.`);
    }
    return abs;
  }

  let current = resolve(cwd);
  while (true) {
    if (hasCatalogDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new UsageError(
        `unable to locate a definitions/ directory from ${cwd}. Set POLARIS_CATALOG_ROOT or run the command from inside the repo.`,
      );
    }
    current = parent;
  }
}

function hasCatalogDir(root: string): boolean {
  const candidate = resolve(root, "definitions");
  if (!existsSync(candidate)) return false;
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
