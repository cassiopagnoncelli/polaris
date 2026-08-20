import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

/**
 * Read-only view of an environment variable bag.
 *
 * The runtime-config package never reaches into `process.env` outside of this
 * module. Every loader receives an `EnvSource` so callers can swap in fake
 * environments for tests without monkey-patching globals.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface LoadEnvOptions {
  /**
   * Files to load, in priority order from highest to lowest. Earlier entries
   * win when keys collide. Missing files are silently skipped — the loader is
   * permissive on purpose so production deployments (which set every value
   * through the process environment) work without any `.env` present.
   *
   * Defaults to no files: callers must opt in to `.env` loading explicitly.
   */
  readonly files?: ReadonlyArray<string>;
  /**
   * Working directory to resolve relative `files` against.
   *
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;
  /**
   * Process-level env to merge in. `.env` entries fill gaps but never
   * override values already present here. This matches the standard
   * production posture: real environment variables win.
   *
   * Defaults to `process.env`.
   */
  readonly processEnv?: NodeJS.ProcessEnv;
}

/**
 * Build a merged env source from process env and optional `.env` files.
 *
 * Precedence (highest first):
 *   1. `processEnv` (defaults to `process.env`)
 *   2. Each file in `files`, in the order given
 *
 * The result is frozen so accidental mutation by callers does not leak back
 * into the rest of the process.
 */
export function loadEnv(options: LoadEnvOptions = {}): EnvSource {
  const cwd = options.cwd ?? process.cwd();
  const processEnv: NodeJS.ProcessEnv = options.processEnv ?? process.env;
  const files: ReadonlyArray<string> = options.files ?? [];

  const merged: Record<string, string | undefined> = {};

  // Walk files in reverse so earlier files overwrite later ones during the
  // forward merge. Missing files are skipped without warning.
  for (const file of [...files].reverse()) {
    const resolved = resolve(cwd, file);
    if (!existsSync(resolved)) {
      continue;
    }
    const contents = readFileSync(resolved, "utf8");
    const parsed = parseDotenv(contents);
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
    }
  }

  // Process env wins last so it overrides any file entries.
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  return Object.freeze(merged);
}

/**
 * Pull a single value out of an env source.
 *
 * Treats empty strings as undefined because shell expansions like
 * `FOO=${BAR}` happily produce empty values when `BAR` is unset. Treating
 * empty as missing lets Zod defaults kick in.
 */
export function readEnv(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  if (value === "") return undefined;
  return value;
}

/**
 * Project an env source down to a plain record of defined values.
 *
 * Used by the loader to feed Zod with a clean shape when parsing schemas
 * that only care about a subset of variables.
 */
export function pickEnv(env: EnvSource, keys: ReadonlyArray<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = readEnv(env, key);
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
