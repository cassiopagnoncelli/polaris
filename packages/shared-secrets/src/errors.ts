import type { SecretProvider } from "./types.js";

/**
 * Base class for all secret-resolution failures.
 *
 * Subclasses carry enough metadata for callers to log / metric the failure
 * without revealing the secret value itself. The base class's contract is:
 *
 *   - `message` never embeds the resolved secret
 *   - `provider` and `ref` are safe to log; they describe the lookup, not
 *     the result
 *   - the cause chain is preserved through `cause` so adapter-level errors
 *     can surface in observability without retyping
 */
export abstract class SecretError extends Error {
  public readonly provider: SecretProvider;
  public readonly ref: string;

  protected constructor(
    name: string,
    message: string,
    provider: SecretProvider,
    ref: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = name;
    this.provider = provider;
    this.ref = ref;
  }
}

/**
 * Thrown when a parsed reference does not resolve to any value in the
 * configured provider. For the env adapter this means the env variable is
 * unset or empty; for Vault it will mean a 404 from the configured mount.
 *
 * Callers should treat this as a configuration error: the platform is being
 * asked to resolve a secret that has not been provisioned yet. The error
 * message never contains the secret value (there is no value to leak), but
 * implementers must take care: if a future adapter retries on partial reads,
 * it must still throw a `SecretNotFoundError` shape that excludes payload
 * fragments.
 */
export class SecretNotFoundError extends SecretError {
  constructor(provider: SecretProvider, ref: string, options?: { cause?: unknown }) {
    super(
      "SecretNotFoundError",
      `secret reference not found (provider="${provider}", ref="${ref}")`,
      provider,
      ref,
      options,
    );
  }
}

/**
 * Thrown when a provider adapter cannot be reached, authenticated, or
 * otherwise fails to complete a lookup. The reference may exist; the platform
 * just cannot fetch it right now. Callers typically should fail closed.
 *
 * The wrapped underlying error is preserved via `cause` for diagnostics, but
 * the public `message` is deliberately generic so logger redaction has the
 * last word. Adapter implementations must not include the resolved secret
 * value in either `message` or `cause` payloads. If an upstream client throws
 * an error that may embed the value (rare but possible for HTTP clients that
 * echo response bodies), the adapter must redact the value before wrapping.
 */
export class SecretProviderError extends SecretError {
  constructor(
    provider: SecretProvider,
    ref: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(
      "SecretProviderError",
      `secret provider failure (provider="${provider}", ref="${ref}"): ${detail}`,
      provider,
      ref,
      options,
    );
  }
}

/**
 * Thrown when a reference targets a provider slot that is reserved in the
 * enum but has no adapter wired up at runtime. Distinguished from
 * `SecretProviderError` so monitoring can detect deployments referencing
 * unconfigured providers without conflating with transport failures.
 */
export class SecretProviderNotConfiguredError extends SecretError {
  constructor(provider: SecretProvider, ref: string) {
    super(
      "SecretProviderNotConfiguredError",
      `secret provider "${provider}" is not configured for this service (ref="${ref}"). ` +
        "Register an adapter before resolving references for this provider.",
      provider,
      ref,
    );
  }
}

/**
 * Thrown when a caller passes a malformed secret-reference string or object.
 * The error never includes the offending input verbatim because callers
 * sometimes accidentally pass values where references were expected — and
 * those values may themselves be secrets.
 */
export class SecretReferenceParseError extends Error {
  public override readonly name = "SecretReferenceParseError";
  public readonly reason: string;

  constructor(reason: string) {
    super(`invalid secret reference: ${reason}`);
    this.reason = reason;
  }
}
