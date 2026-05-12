import { type EnvSource, readEnv } from "@polaris/shared-config";

import { SecretNotFoundError, SecretProviderError } from "../errors.js";
import type { SecretProviderAdapter } from "../types.js";

/**
 * Env-variable name pattern accepted by the adapter.
 *
 * The Polaris convention is uppercase ASCII letters, digits, and underscores,
 * starting with a letter or underscore (POSIX shell-style). This is broader
 * than the platform's own `POLARIS_*` prefix because the adapter must look up
 * arbitrary destination credentials, e.g. `META_CAPI_TOKEN_STOREFRONT_PROD`.
 * Lower-case is rejected because lower-case env vars are an immediate red flag
 * for typos in our deployment pipeline.
 */
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export interface EnvSecretProviderOptions {
  /**
   * Environment source the adapter reads from.
   *
   * Required so production deployments inject a frozen snapshot at startup
   * and tests can inject fakes without touching `process.env`. The platform
   * rule of "no direct `process.env` reads outside shared-config" applies
   * here too — callers compose the source through `loadEnv` or pass their
   * own fake.
   */
  readonly source: EnvSource;
}

/**
 * Environment-variable secret provider.
 *
 * Behavior:
 *
 *   - `ref` must match `ENV_VAR_NAME_PATTERN`. Anything else throws
 *     `SecretProviderError` before any env lookup happens.
 *   - lookups go through `readEnv` from `@polaris/shared-config`, which
 *     treats empty strings as unset. An unset variable throws
 *     `SecretNotFoundError`.
 *   - the resolved value is returned verbatim. The adapter never logs it
 *     and never includes it in error messages.
 *
 * Intended for local/dev and for early production deployments that have not
 * yet wired up a real secret manager. P11-004 ships the Vault adapter for
 * actual production use.
 */
export class EnvSecretProvider implements SecretProviderAdapter {
  public readonly provider = "env" as const;
  private readonly source: EnvSource;

  constructor(options: EnvSecretProviderOptions) {
    this.source = options.source;
  }

  public async getSecret(ref: string): Promise<string> {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new SecretProviderError("env", ref ?? "", "ref must be a non-empty string");
    }
    if (!ENV_VAR_NAME_PATTERN.test(ref)) {
      throw new SecretProviderError(
        "env",
        ref,
        "ref must match /^[A-Z_][A-Z0-9_]*$/ (POSIX-style env var name)",
      );
    }
    const value = readEnv(this.source, ref);
    if (value === undefined) {
      throw new SecretNotFoundError("env", ref);
    }
    return value;
  }
}
