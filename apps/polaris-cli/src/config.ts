import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ConfigError } from "./errors.js";

/**
 * Resolved CLI runtime configuration.
 *
 * The CLI is a thin client — it carries the values needed to call the
 * control-plane API: a base URL, a bearer token, an output mode, and a logger
 * verbosity. Everything else (commands, business state) is server-owned.
 *
 * `apiUrl` and `token` are nullable because every v1 CLI command is
 * DATABASE_URL-direct (see `db/connect.ts`) and none construct an HTTP
 * client. Commands that *do* need the HTTP boundary call
 * {@link requireHttpAuth} to narrow the config to {@link AuthenticatedCliConfig},
 * which moves the "required" error from process startup to the call site.
 * In v1 nothing calls it; the helper is forward-looking infrastructure.
 */
export interface CliConfig {
  /** Active profile name. `default` when no profile is selected. */
  readonly profile: string;
  /**
   * Base URL of the control-plane API (no trailing slash). `null` when
   * `POLARIS_API_URL` is unset and no profile supplied it — fine for v1's
   * DB-direct commands; an HTTP command call site must {@link requireHttpAuth}.
   */
  readonly apiUrl: string | null;
  /**
   * Bearer token read from the env var declared by the active profile. `null`
   * when the env var is unset. The token is NEVER stored in the config file
   * or in process state beyond this struct. Callers should treat it as a
   * secret and avoid logging it (`@polaris/shared-logger`'s redaction list
   * masks `config.token` for safety).
   */
  readonly token: string | null;
  /** Name of the env var the token came from. Useful for diagnostics. */
  readonly tokenEnvName: string;
  /** Output mode requested via `--output` (default `human`). */
  readonly output: OutputFormat;
  /** Log verbosity requested via `--debug` / `--quiet` / `POLARIS_LOG_LEVEL`. */
  readonly logLevel: CliLogLevel;
  /** Resolved path of the config file consulted, if any. */
  readonly configFilePath: string | undefined;
}

/**
 * A {@link CliConfig} narrowed to "ready to make an HTTP call" — both
 * `apiUrl` and `token` are known non-null. Obtain one by calling
 * {@link requireHttpAuth}.
 */
export type AuthenticatedCliConfig = CliConfig & {
  readonly apiUrl: string;
  readonly token: string;
};

export const OUTPUT_FORMATS = ["human", "json"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const CLI_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;
export type CliLogLevel = (typeof CLI_LOG_LEVELS)[number];

/**
 * Default location of the optional per-environment profile file.
 *
 * The file is purely a convenience for operators juggling more than one
 * environment. It points each profile at the env-var name that holds the
 * bearer token; the token itself NEVER appears in the file.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), ".polaris", "config.toml");

const profileSchema = z
  .object({
    url: z.string().trim().min(1, "profile `url` must be a non-empty string"),
    token_env: z.string().trim().min(1, "profile `token_env` must be a non-empty string"),
  })
  .strict();

const configFileSchema = z
  .object({
    profiles: z.record(z.string(), profileSchema).default({}),
    default_profile: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Decoded view of `~/.polaris/config.toml`.
 */
export interface ConfigFile {
  readonly defaultProfile: string | undefined;
  readonly profiles: Readonly<Record<string, ProfileEntry>>;
}

export interface ProfileEntry {
  /** Control-plane API base URL for the profile. */
  readonly url: string;
  /** Name of the env var that holds the bearer token for this profile. */
  readonly tokenEnv: string;
}

export interface LoadConfigOptions {
  /** Process env to read from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit profile selection (e.g. from `--profile`). Takes priority over
   * `POLARIS_PROFILE` and the config file's `default_profile`.
   */
  readonly profile?: string | undefined;
  /**
   * Path to the config TOML. Defaults to `~/.polaris/config.toml`. A missing
   * file is fine — the CLI falls back to pure env-var configuration.
   */
  readonly configFile?: string;
  /** Output mode requested via `--output`. */
  readonly output?: OutputFormat;
  /** Optional log-level override (`--debug` => `debug`, `--quiet` => `warn`). */
  readonly logLevel?: CliLogLevel;
}

/**
 * Load and validate CLI runtime configuration.
 *
 * Resolution order, highest priority first:
 *
 *   1. Explicit options (`profile`, `output`, `logLevel`)
 *   2. Env vars (`POLARIS_PROFILE`, `POLARIS_API_URL`, `POLARIS_TOKEN`, ...)
 *   3. `~/.polaris/config.toml` profile entries
 *
 * Behavior:
 *
 *   - If a profile is requested, the URL comes from the profile entry and the
 *     token comes from the env var the profile points at.
 *   - If no profile is requested but `POLARIS_API_URL` and `POLARIS_TOKEN` are
 *     set, those win — this is the AWS-CLI-style `default` profile.
 *   - Missing required values raise `ConfigError` with a code the entry point
 *     can map to exit code 3.
 *
 * @throws {ConfigError} when required env vars or profile entries are missing
 *   or malformed.
 */
export function loadCliConfig(options: LoadConfigOptions = {}): CliConfig {
  const env = options.env ?? process.env;
  const configFilePath = options.configFile ?? DEFAULT_CONFIG_PATH;
  const configFile = readConfigFile(configFilePath);
  const selectedProfileName = resolveProfileName(options.profile, env, configFile);
  const profileEntry =
    selectedProfileName === "default" ? undefined : configFile?.profiles[selectedProfileName];

  let apiUrl: string | null;
  let tokenEnvName: string;
  if (profileEntry !== undefined) {
    apiUrl = profileEntry.url;
    tokenEnvName = profileEntry.tokenEnv;
  } else if (selectedProfileName !== "default") {
    throw new ConfigError(`profile "${selectedProfileName}" is not defined in ${configFilePath}`, {
      profile: selectedProfileName,
      configFile: configFilePath,
    });
  } else {
    apiUrl = trim(env["POLARIS_API_URL"]) ?? null;
    tokenEnvName = "POLARIS_TOKEN";
  }

  const token = trim(env[tokenEnvName]) ?? null;

  if (apiUrl !== null) validateApiUrl(apiUrl);

  return {
    profile: selectedProfileName,
    apiUrl: apiUrl === null ? null : stripTrailingSlash(apiUrl),
    token,
    tokenEnvName,
    output: options.output ?? "human",
    logLevel: options.logLevel ?? defaultLogLevel(env),
    configFilePath: configFile === undefined ? undefined : configFilePath,
  };
}

/**
 * Narrow a {@link CliConfig} to one ready for HTTP calls — both `apiUrl` and
 * `token` are non-null. Call this at the entry point of any command that
 * constructs an HTTP client; the resulting {@link AuthenticatedCliConfig} can
 * be safely indexed for the URL and bearer.
 *
 * The error messages match those the parse-time check used to emit, so the
 * failure surface for a fresh operator who forgot to export `POLARIS_API_URL`
 * / `POLARIS_TOKEN` is unchanged at the point where it actually matters.
 *
 * In v1 no shipping command calls this — every CLI command is DATABASE_URL
 * direct (see `db/connect.ts`). The helper is forward-looking infrastructure
 * for the first HTTP command.
 *
 * @throws {ConfigError} when `apiUrl` or `token` is null.
 */
export function requireHttpAuth(config: CliConfig): AuthenticatedCliConfig {
  if (config.apiUrl === null) {
    throw new ConfigError(
      "POLARIS_API_URL is required when no profile is selected. Set the env var or pass --profile <name>.",
    );
  }
  if (config.token === null) {
    throw new ConfigError(
      `${config.tokenEnvName} is required (the bearer token for the "${config.profile}" profile).`,
      { tokenEnvName: config.tokenEnvName, profile: config.profile },
    );
  }
  return config as AuthenticatedCliConfig;
}

/**
 * Parse a TOML config file. Returns `undefined` if the file does not exist —
 * the CLI must work without one. Throws `ConfigError` if the file exists but
 * is malformed; a typo in `~/.polaris/config.toml` should fail loudly.
 */
export function readConfigFile(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`failed to read config file at ${path}: ${describeCause(cause)}`, {
      configFile: path,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (cause) {
    throw new ConfigError(`config file ${path} is not valid TOML: ${describeCause(cause)}`, {
      configFile: path,
    });
  }

  const result = configFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`config file ${path} failed validation:\n${issues}`, {
      configFile: path,
    });
  }

  const profiles: Record<string, ProfileEntry> = {};
  for (const [name, entry] of Object.entries(result.data.profiles)) {
    profiles[name] = {
      url: entry.url,
      tokenEnv: entry.token_env,
    };
  }
  return {
    defaultProfile: result.data.default_profile,
    profiles,
  };
}

function resolveProfileName(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  configFile: ConfigFile | undefined,
): string {
  const fromExplicit = trim(explicit);
  if (fromExplicit !== undefined) return fromExplicit;
  const fromEnv = trim(env["POLARIS_PROFILE"]);
  if (fromEnv !== undefined) return fromEnv;
  const fromFile = configFile?.defaultProfile;
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  return "default";
}

function defaultLogLevel(env: NodeJS.ProcessEnv): CliLogLevel {
  const raw = trim(env["POLARIS_LOG_LEVEL"]);
  if (raw === undefined) return "warn";
  const lowered = raw.toLowerCase();
  if ((CLI_LOG_LEVELS as ReadonlyArray<string>).includes(lowered)) {
    return lowered as CliLogLevel;
  }
  // Unknown value: fall back rather than crash; the CLI prints a warning
  // through the normal logger anyway.
  return "warn";
}

function validateApiUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`POLARIS_API_URL must be an absolute URL (got "${value}").`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `POLARIS_API_URL must use http:// or https:// (got "${parsed.protocol}").`,
    );
  }
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
