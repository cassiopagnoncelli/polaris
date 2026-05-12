import { SecretProviderNotConfiguredError } from "./errors.js";
import { parseSecretReference } from "./reference.js";
import type {
  SecretProvider,
  SecretProviderAdapter,
  SecretReference,
  SecretReferenceInput,
} from "./types.js";

/**
 * Options for constructing a `SecretResolver`.
 *
 * `adapters` is a sparse map from provider slot to its adapter. References to
 * an unconfigured slot throw `SecretProviderNotConfiguredError` at resolution
 * time so deployments that depend on an unwired provider fail loudly. The map
 * is shallow-cloned on construction; the resolver does not mutate it
 * thereafter.
 */
export interface SecretResolverOptions {
  readonly adapters: Partial<Record<SecretProvider, SecretProviderAdapter>>;
}

/**
 * Resolve secret references through the appropriate provider adapter.
 *
 * The resolver is the single call site services should use to convert a
 * `(provider, ref)` pair from PostgreSQL (or a CLI flag) into a plaintext
 * value. It accepts both the object and string forms — string form is parsed
 * via `parseSecretReference` so callers do not need to construct the object
 * shape themselves.
 *
 * Resolved values are returned to the caller and must not be retained beyond
 * the immediate use site. The resolver itself performs no caching — caching
 * is an adapter-level concern (Vault adapter caches with TTL; env adapter
 * does not need to).
 *
 * Resolved values must never be logged, embedded in errors, or written to
 * audit / DLQ / delivery records. The platform's logger has redaction paths
 * for common shapes (`secret`, `token`, `api_key`, ...), but callers must
 * still avoid handing the value to anything other than the consuming
 * subsystem.
 */
export class SecretResolver {
  private readonly adapters: Partial<Record<SecretProvider, SecretProviderAdapter>>;

  constructor(options: SecretResolverOptions) {
    this.adapters = { ...options.adapters };
  }

  /**
   * Resolve a reference to its plaintext value.
   *
   * @throws {import("./errors.js").SecretReferenceParseError} when the input
   *   is malformed.
   * @throws {SecretProviderNotConfiguredError} when no adapter is registered
   *   for the parsed provider.
   * @throws {import("./errors.js").SecretNotFoundError} when the adapter
   *   reports the reference does not resolve.
   * @throws {import("./errors.js").SecretProviderError} for adapter transport
   *   or auth failures.
   */
  public async resolve(input: SecretReferenceInput): Promise<string> {
    const reference = parseSecretReference(input);
    const adapter = this.adapters[reference.provider];
    if (!adapter) {
      throw new SecretProviderNotConfiguredError(reference.provider, reference.ref);
    }
    return adapter.getSecret(reference.ref);
  }

  /**
   * Parsed form of a reference. Exposed for callers that want to log /
   * metric the routing without resolving (e.g. CLI dry-run inspectors).
   * The returned object is the same frozen value `resolve` would consume,
   * so it is safe to log.
   */
  public parse(input: SecretReferenceInput): SecretReference {
    return parseSecretReference(input);
  }

  /**
   * Return the list of provider slots this resolver has adapters for. Useful
   * for diagnostics endpoints that surface "what secret providers can this
   * service talk to" without exposing the underlying adapter instances.
   */
  public configuredProviders(): readonly SecretProvider[] {
    return Object.keys(this.adapters) as SecretProvider[];
  }
}
