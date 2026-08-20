/**
 * Shared build/version metadata helper.
 *
 * Every Polaris runtime artifact (apps, processors, consumers) stamps the
 * same four pieces of metadata wherever it identifies itself: the `/health`
 * route, the Pino logger bindings, and the polaris-cli `version` output.
 *
 * The canonical shape lives here so a single helper invocation seeds:
 *
 *   - `ServiceInfo` for `bootstrapService` (the existing health/log surface)
 *   - the polaris-cli `version` command (rendered manually because the CLI
 *     does not run through `bootstrapService`)
 *   - any future caller that wants the same five-field block without going
 *     through Fastify
 *
 * The helper does NOT reach into `process.cwd()` to read `package.json` —
 * the compiled `dist/` for each service has no guarantee about its working
 * directory at runtime, so the package version is always passed in
 * explicitly by the caller (typically `config.service.serviceVersion`).
 *
 * Env vars consumed (all optional, all read directly from the supplied
 * `env` source for test ergonomics):
 *
 *   POLARIS_GIT_SHA         — embedded at container build time
 *   POLARIS_BUILD_TIME      — ISO-8601 timestamp embedded at build time
 *   POLARIS_RELEASE_LABEL   — free-form human pipeline release tag
 *
 * @see docs/deployment/versioning.md "Hybrid versioning"
 * @see infra/docker/build-args.md
 */

/**
 * Canonical Polaris build metadata block.
 *
 * Fields use `null` (not `undefined`) for absence so the helper output is
 * JSON-safe — `JSON.stringify(buildMetadata)` includes every key. The
 * `/health` route serialises this directly; logs use the same shape with
 * snake-case keys (see {@link buildMetadataLogBindings}).
 */
export interface BuildMetadata {
  /** Short service identifier (e.g. `ingester-api`, `consumer-meta-capi-v1`). */
  readonly serviceName: string;
  /**
   * Package version stamped at build time. Falls back to `"0.0.0"` in dev
   * runs (the `@polaris/shared-config` schema default), so callers always
   * have a non-empty string to surface.
   */
  readonly serviceVersion: string;
  /** Git SHA stamped at container build time. `null` when unset. */
  readonly gitSha: string | null;
  /** ISO-8601 UTC build timestamp stamped at container build time. `null` when unset. */
  readonly buildTime: string | null;
  /**
   * Optional human-readable pipeline release label (e.g. `2026-q2-r1`).
   * `null` when unset; the operator opts into setting this for releases
   * that bundle multiple services into a named rollout.
   */
  readonly releaseLabel: string | null;
}

/**
 * Inputs accepted by {@link getBuildMetadata}. The caller supplies the
 * service name + package version explicitly; env-sourced fields are
 * resolved from the optional `env` source (defaults to `process.env`).
 */
export interface GetBuildMetadataOptions {
  /** Service identifier (e.g. `ingester-api`). */
  readonly serviceName: string;
  /**
   * Package/release version. Most callers pass `config.service.serviceVersion`
   * directly — `@polaris/shared-config` already resolves it from the
   * `POLARIS_SERVICE_VERSION` / `POLARIS_BUILD_VERSION` env vars with the
   * `0.0.0` default.
   */
  readonly serviceVersion: string;
  /**
   * Pre-resolved git SHA. Wins over `env.POLARIS_GIT_SHA` when set; useful
   * when the caller already pulled the value out of its typed config.
   */
  readonly gitSha?: string | null | undefined;
  /**
   * Pre-resolved build time. Wins over `env.POLARIS_BUILD_TIME` when set.
   */
  readonly buildTime?: string | null | undefined;
  /**
   * Pre-resolved release label. Wins over `env.POLARIS_RELEASE_LABEL`.
   */
  readonly releaseLabel?: string | null | undefined;
  /**
   * Env-var source. Defaults to `process.env`. Tests pass a deterministic
   * map.
   */
  readonly env?: Record<string, string | undefined>;
}

/**
 * Resolve the canonical build-metadata block for a service.
 *
 * Resolution order, per field:
 *
 *   1. Explicit value passed by the caller (e.g.
 *      `config.service.gitSha`).
 *   2. The matching `POLARIS_*` env var from `env` (defaults to
 *      `process.env`).
 *   3. `null`.
 *
 * Empty / whitespace-only strings collapse to `null` so a partial env
 * never surfaces a misleading value.
 */
export function getBuildMetadata(options: GetBuildMetadataOptions): BuildMetadata {
  const env = options.env ?? process.env;
  return {
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion,
    gitSha: resolveOptional(options.gitSha, env["POLARIS_GIT_SHA"]),
    buildTime: resolveOptional(options.buildTime, env["POLARIS_BUILD_TIME"]),
    releaseLabel: resolveOptional(options.releaseLabel, env["POLARIS_RELEASE_LABEL"]),
  };
}

/**
 * Project the metadata block into snake_case log bindings.
 *
 * Used by callers that want a single object to spread onto a child logger
 * (`logger.child({...buildMetadataLogBindings(meta)})`). `null` fields are
 * dropped so log lines do not carry placeholder `null` values for unset
 * build args.
 */
export function buildMetadataLogBindings(meta: BuildMetadata): Record<string, string> {
  const out: Record<string, string> = {
    service: meta.serviceName,
    version: meta.serviceVersion,
  };
  if (meta.gitSha !== null) out["git_sha"] = meta.gitSha;
  if (meta.buildTime !== null) out["build_time"] = meta.buildTime;
  if (meta.releaseLabel !== null) out["release_label"] = meta.releaseLabel;
  return out;
}

function resolveOptional(
  explicit: string | null | undefined,
  fromEnv: string | undefined,
): string | null {
  if (typeof explicit === "string") {
    const trimmed = explicit.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (explicit === null) return null;
  if (typeof fromEnv === "string") {
    const trimmed = fromEnv.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}
