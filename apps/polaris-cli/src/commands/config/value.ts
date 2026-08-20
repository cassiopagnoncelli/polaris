/**
 * Shared argument handling for the `polaris config` group.
 *
 * The interesting decision here is {@link parseConfigValue}. An operator types
 * `--value 5000` and means the number 5000; `--value graph.facebook.com` and
 * means that string. The column is `jsonb`, so the difference survives to the
 * consumer's Zod schema — and `positiveIntSchema` coerces either way, which is
 * exactly why the schemas reused from the env-var era keep working.
 */

import { POLARIS_ENVIRONMENTS } from "@polaris/runtime-environments";
import type { AuditEnvironment } from "../../db/index.js";
import { UsageError } from "../../errors.js";

export const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;

/** Mirrors `project_config_namespace_format` in the migration. */
const NAMESPACE_FORMAT = /^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/;
/** Mirrors `project_config_key_format`. */
const CONFIG_KEY_FORMAT = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;

export function requireProject(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new UsageError("--project is required");
  return trimmed;
}

export function requireEnvironment(value: string | undefined): AuditEnvironment {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new UsageError("--env is required");
  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(trimmed)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${trimmed}")`,
    );
  }
  return trimmed as AuditEnvironment;
}

export function requireNamespace(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new UsageError("--namespace is required");
  if (!NAMESPACE_FORMAT.test(trimmed)) {
    throw new UsageError(
      `--namespace must match ${String(NAMESPACE_FORMAT)} (got "${trimmed}"). ` +
        "It names the component that reads the value, e.g. meta-capi, sessionizer, ingest.",
    );
  }
  return trimmed;
}

export function requireConfigKey(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new UsageError("--key is required");
  if (!CONFIG_KEY_FORMAT.test(trimmed)) {
    throw new UsageError(
      `--key must match ${String(CONFIG_KEY_FORMAT)} (got "${trimmed}"). ` +
        "Keys are lowercase snake_case, e.g. pixel_id, request_timeout_ms.",
    );
  }
  return trimmed;
}

export function requireReason(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) throw new UsageError("--reason is required");
  return trimmed;
}

/**
 * Parse `--value` as JSON when it parses, otherwise keep it a string.
 *
 * `5000` becomes a number, `true` a boolean, `["a","b"]` an array, and
 * `graph.facebook.com` stays a string rather than failing to parse.
 *
 * A secret always stays a string, and this is the code that satisfies the
 * `project_config_secret_is_string` CHECK. It also stops a credential that
 * happens to be all digits from being silently retyped as a number and losing
 * its leading zeroes.
 */
export function parseConfigValue(raw: string, isSecret: boolean): unknown {
  if (isSecret) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
