import { type ZodType, z } from "zod";
import { type EnvSource, type LoadEnvOptions, loadEnv } from "./env.js";
import { ConfigValidationError } from "./errors.js";

/**
 * Options accepted by `loadConfig`.
 *
 * The schema may be any Zod type. It is the caller's responsibility to make
 * sure the schema accepts an env-shaped object (i.e. keys are uppercase env
 * variable names, values are strings). Most callers will compose a single
 * `z.object({...})` from the schema fragments exported by `./schemas`.
 */
export interface LoadConfigOptions<Schema extends ZodType> extends LoadEnvOptions {
  /**
   * Identifier used in error messages and intended to match the service's
   * `POLARIS_SERVICE_NAME`. Required so a misconfigured service fails with a
   * message that names the service rather than a generic Zod dump.
   */
  readonly serviceName: string;
  /**
   * Zod schema describing the env vars this service needs. Should produce
   * the final, typed config object via `.transform(...)`.
   */
  readonly schema: Schema;
  /**
   * Pre-built env source. When provided, `files`, `cwd`, and `processEnv`
   * from `LoadEnvOptions` are ignored. Useful for tests.
   */
  readonly env?: EnvSource;
}

/**
 * Load and validate runtime configuration.
 *
 * Behavior:
 *
 *   1. Resolve an env source (either the caller-provided one or one built
 *      from process env + the requested `.env` files).
 *   2. Run the schema against the env source.
 *   3. On success, return the parsed config.
 *   4. On failure, throw `ConfigValidationError` containing every issue.
 *
 * Services should call this exactly once at startup, before constructing any
 * other subsystems. The error must be allowed to crash the process — that is
 * the architecture's "fail fast on invalid required config" rule.
 *
 * @throws {ConfigValidationError} when the schema rejects the env source.
 */
export function loadConfig<Schema extends ZodType>(
  options: LoadConfigOptions<Schema>,
): Schema["_output"] {
  const env = options.env ?? loadEnvFromOptions(options);
  const result = options.schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(options.serviceName, result.error);
  }
  return result.data;
}

function loadEnvFromOptions<Schema extends ZodType>(options: LoadConfigOptions<Schema>): EnvSource {
  return loadEnv({
    ...(options.files !== undefined ? { files: options.files } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.processEnv !== undefined ? { processEnv: options.processEnv } : {}),
  });
}

/**
 * Build a single Zod schema that runs every sub-schema against the same flat
 * env source and stitches the results into a namespaced config object.
 *
 * This is the recommended composition pattern: every shared schema in
 * `./schemas` consumes a flat `Record<string, string>` keyed by uppercase env
 * variable names, so services can pick the fragments they need without
 * worrying about how to merge input shapes.
 *
 * Example:
 *
 * ```ts
 * const schema = composeConfigSchema({
 *   service: serviceEnvSchema,
 *   postgres: postgresEnvSchema,
 *   rabbitmq: rabbitmqEnvSchema,
 * });
 * const config = loadConfig({ serviceName: "ingester-api", schema });
 * config.service.serviceName; // typed
 * config.postgres.host;       // typed
 * ```
 */
export function composeConfigSchema<Shape extends Record<string, ZodType>>(
  shape: Shape,
): ZodType<ComposedConfig<Shape>> {
  type Out = ComposedConfig<Shape>;
  return z.unknown().transform((env, ctx): Out => {
    const out = {} as { [K in keyof Shape]?: z.output<Shape[K]> };
    let hadFailure = false;
    for (const key of Object.keys(shape) as Array<keyof Shape>) {
      const subSchema = shape[key] as ZodType;
      const result = subSchema.safeParse(env);
      if (result.success) {
        out[key] = result.data as z.output<Shape[typeof key]>;
      } else {
        hadFailure = true;
        for (const issue of result.error.issues) {
          ctx.addIssue({
            ...issue,
            path: [String(key), ...issue.path],
          });
        }
      }
    }
    if (hadFailure) return z.NEVER as unknown as Out;
    return out as Out;
  });
}

export type ComposedConfig<Shape extends Record<string, ZodType>> = {
  readonly [K in keyof Shape]: z.output<Shape[K]>;
};

/**
 * Convenience wrapper around `loadConfig` that auto-loads the standard local
 * dev `.env` files in order. Production hosts ignore the files entirely
 * because they inject env vars directly.
 *
 * Order (highest priority first, after `process.env`):
 *
 *   .env.{POLARIS_ENV}.local
 *   .env.local
 *   .env.{POLARIS_ENV}
 *   .env
 *
 * If `POLARIS_ENV` is not set in the process environment when this function
 * runs, the env-suffixed files are skipped so we never silently load
 * `.env.production` on a developer machine that forgot to set the variable.
 */
export function loadConfigWithDefaults<Schema extends ZodType>(
  options: Omit<LoadConfigOptions<Schema>, "files">,
): Schema["_output"] {
  return loadConfig({ ...options, files: defaultEnvFiles(options.processEnv ?? process.env) });
}

/**
 * The standard `.env` file cascade for a process environment. Shared by
 * {@link loadConfigWithDefaults} and {@link loadEnvWithDefaults} so the two
 * can never disagree about which files exist.
 */
function defaultEnvFiles(env: NodeJS.ProcessEnv): string[] {
  const polarisEnv: string | undefined = env["POLARIS_ENV"];
  const files: string[] = [];
  if (polarisEnv) files.push(`.env.${polarisEnv}.local`);
  files.push(".env.local");
  if (polarisEnv) files.push(`.env.${polarisEnv}`);
  files.push(".env");
  return files;
}

/**
 * A frozen env snapshot built with the SAME file cascade
 * {@link loadConfigWithDefaults} feeds the config schema.
 *
 * This exists because there are two consumers of "the environment" in a
 * service — the config loader, and the `env:` secret provider — and they must
 * see one universe. A bare `loadEnv()` reads no files at all, so a service
 * wired that way resolves `POLARIS_*` config from `.env.local` while
 * `env:MY_TOKEN` from the same file fails as not-found: two behaviours for
 * one file, and the difference is invisible until someone stores a secret.
 *
 * Production hosts inject real environment variables and carry no `.env`
 * files, so there this is byte-identical to `loadEnv()`.
 */
export function loadEnvWithDefaults(options: Omit<LoadEnvOptions, "files"> = {}): EnvSource {
  return loadEnv({ ...options, files: defaultEnvFiles(options.processEnv ?? process.env) });
}
