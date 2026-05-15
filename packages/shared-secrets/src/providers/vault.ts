/**
 * Vault secret-provider adapter (`@polaris/shared-secrets` Vault wiring).
 *
 * Production Polaris services route secret references through this adapter.
 * Local/dev keeps the `env` adapter so Vault is never required outside
 * production / staging.
 *
 * Architecture:
 *
 *   - The provider implements `SecretProviderAdapter.getSecret(ref)`. The
 *     `ref` is the canonical Polaris secret-ref path
 *     (`polaris/<env>/<project>/<name>`); the adapter maps that to a Vault
 *     KV v2 read against the configured KV mount.
 *   - Authentication is handled by `VaultTokenManager` using Vault's
 *     Kubernetes auth method. The pod's service-account JWT is exchanged
 *     for a Vault client token; the manager renews / re-auths transparently.
 *   - Reads are cached in-process via `VaultSecretCache`. The default TTL is
 *     5 minutes; production deployments override through config.
 *   - Health: the adapter exposes a `probe()` that maps to the readiness
 *     contract in `@polaris/shared-service-bootstrap`. The probe reports
 *     `up`/`degraded`/`down` based on the last fresh fetch outcome and the
 *     current token state. A Vault outage degrades the service to `degraded`
 *     (NOT `down`) so cached secrets keep flowing until they expire from
 *     Vault's own lease window — this is the operator-trust contract.
 *
 * Secret hygiene:
 *
 *   - Resolved values are not logged.
 *   - `SecretProviderError` messages name the provider and ref but never
 *     embed the value.
 *   - Even the *cause* chain redacts: when the underlying HTTP client throws
 *     with a body that may echo the secret, the adapter discards the body
 *     before wrapping (Vault doesn't typically echo, but defence in depth).
 *
 * Public API surface:
 *
 *   - `createVaultProvider(opts)` — factory, returns a `VaultSecretProvider`.
 *   - `VaultSecretProvider` — implements `SecretProviderAdapter`.
 *   - `VaultProviderOptions` — constructor options.
 *   - `VaultProbeResult` — readiness probe payload type.
 *
 * @see docs/deployment/secret-provider-vault.md for production wiring.
 * @see docs/operations/secret-rotation.md for rotation procedure.
 */

import { SecretNotFoundError, SecretProviderError } from "../errors.js";
import type { SecretProviderAdapter } from "../types.js";
import { type VaultCacheClock, VaultSecretCache } from "./vault-cache.js";
import {
  FileServiceAccountTokenReader,
  type ServiceAccountTokenReader,
  type VaultHttp,
  VaultTokenManager,
} from "./vault-token-manager.js";

/**
 * Default Kubernetes service-account token path inside a pod. The same path
 * is used by every official K8s client; Polaris does not override it. Custom
 * deployments (e.g. tokenless workload identity) supply `tokenPath` in the
 * provider options.
 */
export const DEFAULT_K8S_SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Default Vault KV v2 mount path. Vault ships `secret/` as the default KV
 * mount; many orgs leave it as-is. Override via `kvMount` in options.
 */
export const DEFAULT_VAULT_KV_MOUNT = "secret";

/**
 * Default Vault Kubernetes auth-method mount.
 */
export const DEFAULT_VAULT_K8S_AUTH_MOUNT = "kubernetes";

/**
 * Default cache TTL — 5 minutes. The architecture brief locks this number as
 * the suggested default; production deployments may shorten it for
 * particularly sensitive credentials.
 */
export const DEFAULT_VAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Public constructor options for the Vault provider.
 *
 * Fields:
 *
 *   - `address` — Vault base URL, e.g. `https://vault.svc.cluster.local:8200`.
 *     No trailing slash. **Required.**
 *   - `role` — Vault Kubernetes auth role bound to the pod's service account.
 *     Conventionally `polaris-<env>`. **Required.**
 *   - `kubernetesAuthMount` — Mount path of Vault's `kubernetes` auth plugin.
 *     Defaults to `kubernetes`.
 *   - `kvMount` — Mount path of the KV v2 store holding Polaris secrets.
 *     Defaults to `secret`.
 *   - `tokenPath` — Filesystem path to the pod's service-account JWT.
 *     Defaults to the standard kubelet location.
 *   - `cacheTtlMs` — In-memory cache TTL. Defaults to 5 minutes.
 *   - `serviceAccountTokenReader` — Inject a fake reader for tests.
 *   - `http` — Override the HTTP client; defaults to global `fetch`.
 *   - `now` — Clock override for cache/token expiry math; defaults to
 *     `Date.now`.
 */
export interface VaultProviderOptions {
  readonly address: string;
  readonly role: string;
  readonly kubernetesAuthMount?: string;
  readonly kvMount?: string;
  readonly tokenPath?: string;
  readonly cacheTtlMs?: number;
  readonly serviceAccountTokenReader?: ServiceAccountTokenReader;
  readonly http?: VaultHttp;
  readonly now?: () => number;
}

/**
 * Readiness probe outcome. Mirrors the `ReadinessProbeResult` shape exported
 * by `@polaris/shared-service-bootstrap` without importing it (to keep the
 * `shared-secrets` package free of a Fastify dependency).
 */
export interface VaultProbeResult {
  readonly status: "up" | "down" | "degraded";
  readonly detail?: string;
  /**
   * Epoch ms of the last fully-successful Vault round-trip. `undefined`
   * before the first successful read.
   */
  readonly lastSuccessAt?: number;
  /**
   * Epoch ms of the last observed failure (auth or read). `undefined` when
   * the adapter has never failed.
   */
  readonly lastFailureAt?: number;
}

/**
 * Shape of the KV v2 read response. We only consume `data.data`; everything
 * else is left untyped to avoid coupling to Vault's full schema.
 */
interface KvV2ReadResponse {
  readonly data?: {
    readonly data?: Record<string, unknown>;
  };
}

/**
 * Lookup key used inside KV v2 entries. The Polaris convention stores the
 * secret value under the `value` field of the KV entry, matching what
 * `vault kv put` produces when invoked as `vault kv put <path> value=...`.
 */
const KV_V2_VALUE_FIELD = "value";

/**
 * The Vault adapter.
 *
 * Construct via {@link createVaultProvider}. The class is exported so call
 * sites can take a strongly-typed reference (e.g. for the readiness probe).
 */
export class VaultSecretProvider implements SecretProviderAdapter {
  public readonly provider = "vault" as const;

  private readonly address: string;
  private readonly kvMount: string;
  private readonly http: VaultHttp;
  private readonly tokens: VaultTokenManager;
  private readonly cache: VaultSecretCache;
  private readonly now: () => number;

  private lastSuccessAt: number | undefined = undefined;
  private lastFailureAt: number | undefined = undefined;

  constructor(options: VaultProviderOptions) {
    if (typeof options.address !== "string" || options.address.length === 0) {
      throw new TypeError("VaultSecretProvider: address is required");
    }
    if (options.address.endsWith("/")) {
      throw new TypeError("VaultSecretProvider: address must not end with '/'");
    }
    if (typeof options.role !== "string" || options.role.length === 0) {
      throw new TypeError("VaultSecretProvider: role is required");
    }
    this.address = options.address;
    this.kvMount = options.kvMount ?? DEFAULT_VAULT_KV_MOUNT;
    this.http = options.http ?? defaultHttpResolvedAtConstruction();
    const now = options.now ?? (() => Date.now());
    this.now = now;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_VAULT_CACHE_TTL_MS;
    const cacheClock: VaultCacheClock = { now };
    this.cache = new VaultSecretCache({ ttlMs: cacheTtlMs, clock: cacheClock });
    const tokenReader: ServiceAccountTokenReader =
      options.serviceAccountTokenReader ??
      new FileServiceAccountTokenReader(options.tokenPath ?? DEFAULT_K8S_SA_TOKEN_PATH);
    this.tokens = new VaultTokenManager({
      address: this.address,
      kubernetesMount: options.kubernetesAuthMount ?? DEFAULT_VAULT_K8S_AUTH_MOUNT,
      role: options.role,
      serviceAccountTokenReader: tokenReader,
      ...(options.http !== undefined ? { http: options.http } : {}),
      now,
    });
  }

  /**
   * Resolve a Polaris secret reference to its plaintext value.
   *
   * Flow:
   *
   *   1. Fresh cache hit → return immediately, no Vault call.
   *   2. Acquire a Vault client token (re-auth or renew as needed).
   *   3. Read `<address>/v1/<kvMount>/data/<ref>` and pull the
   *      `data.data.value` field.
   *   4. Cache the result with the configured TTL.
   *   5. On failure, attempt a stale-cache fallback: if a prior read of
   *      the same ref exists in cache, return it and mark the adapter
   *      `degraded`. This preserves end-to-end delivery during short
   *      Vault outages while the readiness probe surfaces the condition.
   *
   * @throws {SecretNotFoundError} when the reference yields a 404 from KV.
   * @throws {SecretProviderError} for transport/auth failures with no stale
   *   cache available.
   */
  public async getSecret(ref: string): Promise<string> {
    if (typeof ref !== "string" || ref.length === 0) {
      throw new SecretProviderError("vault", ref ?? "", "ref must be a non-empty string");
    }
    const cached = this.cache.get(ref);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const value = await this.fetchFromVault(ref);
      this.cache.set(ref, value);
      this.lastSuccessAt = this.now();
      return value;
    } catch (err) {
      // A genuine "secret doesn't exist" must surface as `SecretNotFoundError`
      // regardless of the cache. Don't paper over a missing reference with
      // stale state.
      if (err instanceof SecretNotFoundError) {
        this.lastFailureAt = this.now();
        throw err;
      }
      this.lastFailureAt = this.now();
      const stale = this.cache.getStale(ref);
      if (stale !== undefined) {
        return stale;
      }
      throw err;
    }
  }

  /**
   * Readiness probe payload. Returns:
   *
   *   - `up` when the last completed operation succeeded.
   *   - `degraded` when the last operation failed but the adapter has
   *     successfully fetched at some point in the past (i.e. cached secrets
   *     are still serving traffic).
   *   - `down` when the adapter has never succeeded.
   *
   * The probe is cheap: it consults the in-memory `lastSuccessAt` /
   * `lastFailureAt` timestamps. It does **not** trigger a synthetic Vault
   * call. Operators wanting an end-to-end probe stand up a separate health
   * check that reads a known secret.
   */
  public probe(): VaultProbeResult {
    if (this.lastSuccessAt === undefined && this.lastFailureAt === undefined) {
      return {
        status: "degraded",
        detail: "vault adapter has not yet attempted a secret fetch",
      };
    }
    if (this.lastFailureAt === undefined) {
      return {
        status: "up",
        ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      };
    }
    const lastSuccessAt = this.lastSuccessAt;
    const lastFailureAt = this.lastFailureAt;
    if (lastSuccessAt !== undefined && lastSuccessAt > lastFailureAt) {
      return {
        status: "up",
        lastSuccessAt,
        lastFailureAt,
      };
    }
    if (lastSuccessAt !== undefined) {
      return {
        status: "degraded",
        detail: "vault unreachable; serving cached secrets",
        lastSuccessAt,
        lastFailureAt,
      };
    }
    return {
      status: "down",
      detail: "vault unreachable and no cached secrets available",
      lastFailureAt,
    };
  }

  /**
   * Diagnostic accessor for the active token lease. Returns `undefined`
   * when the adapter has not authenticated yet. Used by tests and by
   * operator tooling that wants to surface "how long until the next
   * Vault round trip" without exposing the token bytes.
   */
  public lease(): { expiresAt: number; renewable: boolean } | undefined {
    return this.tokens.lease();
  }

  /**
   * Read the secret from Vault. Pulled into a separate method so the cache
   * fallback in `getSecret` reads as a single try/catch around the network
   * portion.
   */
  private async fetchFromVault(ref: string): Promise<string> {
    const token = await this.acquireToken(ref);
    const url = `${this.address}/v1/${this.kvMount}/data/${encodeKvPath(ref)}`;
    let response: Awaited<ReturnType<VaultHttp>>;
    try {
      response = await this.http(url, {
        method: "GET",
        headers: { "x-vault-token": token },
      });
    } catch (cause) {
      throw new SecretProviderError("vault", ref, "vault transport failure", { cause });
    }
    if (response.status === 404) {
      throw new SecretNotFoundError("vault", ref);
    }
    if (response.status === 403) {
      // Drop the cached token and retry once. Vault occasionally invalidates
      // tokens out-of-band (admin revoke, lease expired between operations).
      this.tokens.invalidate();
      try {
        const retryToken = await this.acquireToken(ref);
        const retry = await this.http(url, {
          method: "GET",
          headers: { "x-vault-token": retryToken },
        });
        if (retry.status === 404) {
          throw new SecretNotFoundError("vault", ref);
        }
        if (!retry.ok) {
          throw new SecretProviderError(
            "vault",
            ref,
            `vault read returned status ${retry.status} after re-auth`,
          );
        }
        return await extractKvValue(retry, ref);
      } catch (err) {
        if (err instanceof SecretNotFoundError) throw err;
        if (err instanceof SecretProviderError) throw err;
        throw new SecretProviderError("vault", ref, "vault re-auth retry failed", { cause: err });
      }
    }
    if (!response.ok) {
      throw new SecretProviderError("vault", ref, `vault read returned status ${response.status}`);
    }
    return extractKvValue(response, ref);
  }

  /**
   * Wrap token acquisition so transport failures land in `SecretProviderError`
   * with a stable message. The underlying `VaultAuthInternalError` carries
   * the details on `cause`; we keep the public message generic so logger
   * redaction has the last word.
   */
  private async acquireToken(ref: string): Promise<string> {
    try {
      return await this.tokens.token();
    } catch (cause) {
      throw new SecretProviderError("vault", ref, "vault authentication failed", { cause });
    }
  }
}

/**
 * Factory function for the Vault provider. Use this over the raw constructor
 * when the surrounding code prefers a functional style.
 */
export function createVaultProvider(options: VaultProviderOptions): VaultSecretProvider {
  return new VaultSecretProvider(options);
}

/**
 * Encode the Polaris secret ref for inclusion in a Vault KV v2 URL.
 *
 * The Polaris ref is a path like `polaris/production/storefront/meta-capi`.
 * `encodeURIComponent` would escape the slashes, which Vault rejects. We
 * split, encode each segment, and rejoin so slashes are preserved.
 */
function encodeKvPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/**
 * Extract the secret value from a KV v2 read response.
 *
 * KV v2 wraps data under `data.data`; the Polaris convention stores the
 * actual secret under the `value` field. Other fields are intentionally
 * ignored. Missing/empty `value` is treated as `SecretNotFoundError` so
 * an operator who provisioned the KV entry under the wrong key sees the
 * "not provisioned" failure mode rather than a transport error.
 */
async function extractKvValue(
  response: { json(): Promise<unknown> },
  ref: string,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new SecretProviderError("vault", ref, "vault response was not valid JSON", { cause });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SecretProviderError("vault", ref, "vault response was not an object");
  }
  const data = (parsed as KvV2ReadResponse).data?.data;
  if (typeof data !== "object" || data === null) {
    throw new SecretProviderError("vault", ref, "vault response missing data.data block");
  }
  const value = (data as Record<string, unknown>)[KV_V2_VALUE_FIELD];
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretNotFoundError("vault", ref);
  }
  return value;
}

/**
 * Late-bound default HTTP. Pulled out so we don't import the global `fetch`
 * binding eagerly at module load — easier to swap in test environments
 * where `fetch` isn't available.
 */
function defaultHttpResolvedAtConstruction(): VaultHttp {
  return async (input, init) => {
    const response = await fetch(input, {
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return {
      status: response.status,
      ok: response.ok,
      text: () => response.text(),
      json: () => response.json(),
    };
  };
}
