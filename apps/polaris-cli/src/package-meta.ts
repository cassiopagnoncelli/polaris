/**
 * Build metadata for the `polaris` CLI, surfaced by `polaris version`.
 *
 * `version` is the package's `version` field at compile time. The other
 * fields are populated by the container build (or local dev tooling) through
 * env vars and are deliberately optional — the CLI must still print something
 * useful on a developer laptop with nothing wired up.
 */
export interface PackageMeta {
  /** Package version from `apps/polaris-cli/package.json` at build time. */
  readonly version: string;
  /** Build-time git commit SHA, if the build embedded one. */
  readonly gitSha: string | undefined;
  /** Build-time ISO 8601 UTC timestamp, if the build embedded one. */
  readonly buildTime: string | undefined;
  /** Node.js runtime version reported by `process.version`. */
  readonly nodeVersion: string;
}

/**
 * Pinned at scaffold time; updated only when the package's `version` bumps.
 *
 * The package version is duplicated here (rather than read from
 * `package.json` at runtime) because the compiled `dist/` binary cannot
 * resolve workspace-relative `package.json` files at runtime without
 * hard-coding paths that break under different install layouts.
 */
const PACKAGE_VERSION = "0.0.0";

/**
 * Resolve build metadata, preferring env vars set by the production build over
 * locally-derived defaults. Callers should treat the result as a snapshot —
 * it is computed once at process start, not re-read between commands.
 */
export function resolvePackageMeta(env: NodeJS.ProcessEnv = process.env): PackageMeta {
  return {
    version: PACKAGE_VERSION,
    gitSha: nonEmpty(env["POLARIS_GIT_SHA"]),
    buildTime: nonEmpty(env["POLARIS_BUILD_TIME"]),
    nodeVersion: process.version,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
