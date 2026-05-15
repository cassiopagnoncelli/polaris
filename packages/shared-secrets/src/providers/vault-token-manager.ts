/**
 * Vault Kubernetes-auth token manager.
 *
 * Polaris production services run inside Kubernetes. Each pod has a service
 * account; the kubelet writes a JWT-signed service-account token to a path
 * inside the pod (the default is `/var/run/secrets/kubernetes.io/serviceaccount/token`).
 * Vault's `kubernetes` auth method verifies that JWT against the cluster's
 * TokenReview API and returns a short-lived Vault client token plus a lease
 * window. The token manager owns:
 *
 *   1. Reading the K8s SA token (re-read on every Vault auth — the kubelet
 *      rotates it on its own schedule).
 *   2. Calling Vault's `auth/<mount>/login` endpoint.
 *   3. Holding the current Vault token in memory.
 *   4. Renewing the token when it gets within 25% of the lease window from
 *      expiry. Renewal is opportunistic: we do not run a background timer.
 *      A timer would keep the event loop open during shutdown and create a
 *      shutdown-ordering hazard. Instead, the {@link VaultTokenManager.token}
 *      method is called from every KV read path; the manager checks expiry
 *      on access and refreshes inline when needed.
 *   5. Falling back to a full re-auth when renewal returns `403` (token
 *      revoked or the lease window was exceeded between checks).
 *
 * Failures throw an opaque error with no token bytes in the message; the
 * outer Vault provider wraps this into a `SecretProviderError`.
 *
 * The manager never logs the K8s SA token, the Vault token, or any portion
 * of either. Tests assert the no-leak property.
 */

import { readFile } from "node:fs/promises";

/**
 * Minimal fetch surface this module depends on. Mirrors the global
 * `fetch`/`Response` shape; tests inject a stub.
 */
export interface VaultHttp {
  (input: string, init: VaultHttpInit): Promise<VaultHttpResponse>;
}

export interface VaultHttpInit {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface VaultHttpResponse {
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Default HTTP client uses the global `fetch`. Node 22 ships it natively;
 * the workspace's runtime baseline is Node 22+.
 */
export const defaultVaultHttp: VaultHttp = async (input, init) => {
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

/**
 * Reader for the Kubernetes service-account token file. Injectable so tests
 * never touch the real filesystem.
 */
export interface ServiceAccountTokenReader {
  read(): Promise<string>;
}

/**
 * Default reader: reads the configured path with UTF-8 encoding.
 */
export class FileServiceAccountTokenReader implements ServiceAccountTokenReader {
  constructor(private readonly path: string) {}

  public async read(): Promise<string> {
    const raw = await readFile(this.path, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new VaultAuthInternalError("kubernetes service-account token file is empty");
    }
    return trimmed;
  }
}

/**
 * Internal-only error thrown by the token manager. The outer provider
 * always wraps these into `SecretProviderError` so the public message
 * shape stays consistent.
 *
 * Messages must never include token bytes (SA token or Vault token).
 */
export class VaultAuthInternalError extends Error {
  public override readonly name = "VaultAuthInternalError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Options for `VaultTokenManager`.
 */
export interface VaultTokenManagerOptions {
  /** Vault base address, e.g. `https://vault.svc:8200`. No trailing slash. */
  readonly address: string;
  /**
   * Kubernetes auth method mount. Defaults to `kubernetes`. Customise when
   * the org mounts the plugin at a non-default path
   * (e.g. `kubernetes-prod`).
   */
  readonly kubernetesMount: string;
  /** Kubernetes auth role to log in as. Required. */
  readonly role: string;
  /** Reader for the K8s service-account token. */
  readonly serviceAccountTokenReader: ServiceAccountTokenReader;
  /** HTTP client. Defaults to the global `fetch`. */
  readonly http?: VaultHttp;
  /**
   * Clock for expiry math. Defaults to `Date.now`; tests inject a fake clock.
   */
  readonly now?: () => number;
  /**
   * Fraction of the lease window remaining at which the manager triggers a
   * renewal. Defaults to `0.25` — renew when 25% of the lease is left. Must
   * be in (0, 1).
   */
  readonly renewAtFraction?: number;
}

interface ActiveToken {
  readonly value: string;
  /** Absolute expiry, epoch milliseconds, based on the original lease ttl. */
  readonly expiresAt: number;
  /** The lease ttl Vault reported when the token was minted. */
  readonly originalLeaseTtlMs: number;
  /** Whether Vault marked the token as renewable. */
  readonly renewable: boolean;
}

interface VaultLoginResponse {
  readonly auth?: {
    readonly client_token?: unknown;
    readonly lease_duration?: unknown;
    readonly renewable?: unknown;
  };
}

interface VaultRenewResponse {
  readonly auth?: {
    readonly client_token?: unknown;
    readonly lease_duration?: unknown;
    readonly renewable?: unknown;
  };
}

/**
 * Vault Kubernetes-auth token manager.
 *
 * The manager is concurrency-safe in the single-process JS sense: callers
 * may invoke `token()` from any number of concurrent KV reads; an in-flight
 * authentication is shared via a promise so we never thunder-herd Vault's
 * login endpoint with the same K8s JWT.
 */
export class VaultTokenManager {
  private readonly address: string;
  private readonly kubernetesMount: string;
  private readonly role: string;
  private readonly serviceAccountTokenReader: ServiceAccountTokenReader;
  private readonly http: VaultHttp;
  private readonly now: () => number;
  private readonly renewAtFraction: number;

  private active: ActiveToken | undefined = undefined;
  private inflight: Promise<ActiveToken> | undefined = undefined;

  constructor(options: VaultTokenManagerOptions) {
    if (typeof options.address !== "string" || options.address.length === 0) {
      throw new TypeError("VaultTokenManager: address is required");
    }
    if (options.address.endsWith("/")) {
      throw new TypeError("VaultTokenManager: address must not end with '/'");
    }
    if (typeof options.role !== "string" || options.role.length === 0) {
      throw new TypeError("VaultTokenManager: role is required");
    }
    const renewAtFraction = options.renewAtFraction ?? 0.25;
    if (!(renewAtFraction > 0 && renewAtFraction < 1)) {
      throw new TypeError("VaultTokenManager: renewAtFraction must be in (0, 1)");
    }
    this.address = options.address;
    this.kubernetesMount = options.kubernetesMount;
    this.role = options.role;
    this.serviceAccountTokenReader = options.serviceAccountTokenReader;
    this.http = options.http ?? defaultVaultHttp;
    this.now = options.now ?? (() => Date.now());
    this.renewAtFraction = renewAtFraction;
  }

  /**
   * Return a currently-valid Vault client token. May trigger:
   *
   *   - a full re-auth (no token yet, token expired, or last renewal 403'd);
   *   - a renewal (token is renewable and within `renewAtFraction` of expiry);
   *   - nothing (token is fresh enough).
   *
   * Concurrent callers share a single in-flight auth promise so we never
   * burst-spend the K8s SA token nor hammer Vault's login endpoint.
   */
  public async token(): Promise<string> {
    const active = this.active;
    if (active !== undefined) {
      const remainingMs = active.expiresAt - this.now();
      if (remainingMs > active.originalLeaseTtlMs * this.renewAtFraction) {
        return active.value;
      }
      if (active.renewable && remainingMs > 0) {
        const renewed = await this.renew(active);
        if (renewed !== undefined) return renewed.value;
        // Renewal failed (e.g. lease window exceeded). Fall through to a
        // full re-auth.
      }
    }
    const fresh = await this.runOrJoin(() => this.login());
    return fresh.value;
  }

  /**
   * Discard the current token state. Used by the provider when a downstream
   * KV read returns 403 (auth invalidated out-of-band, e.g. a Vault admin
   * revoked the lease, or the kubelet rotated the SA token mid-flight). The
   * next `token()` call will re-auth from scratch.
   */
  public invalidate(): void {
    this.active = undefined;
  }

  /**
   * Read-only view of the active token's lease window. Returns `undefined`
   * when no token is held. Used by the readiness probe; never includes the
   * token bytes.
   */
  public lease(): { expiresAt: number; renewable: boolean } | undefined {
    if (this.active === undefined) return undefined;
    return { expiresAt: this.active.expiresAt, renewable: this.active.renewable };
  }

  /**
   * Share a single in-flight auth/renew across concurrent callers.
   */
  private async runOrJoin(work: () => Promise<ActiveToken>): Promise<ActiveToken> {
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        const result = await work();
        this.active = result;
        return result;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /**
   * Full login via `auth/<mount>/login`. Reads the K8s SA token fresh; the
   * kubelet rotates it independently and a long-lived in-memory copy would
   * eventually go stale.
   */
  private async login(): Promise<ActiveToken> {
    const jwt = await this.readServiceAccountToken();
    const url = `${this.address}/v1/auth/${this.kubernetesMount}/login`;
    let response: VaultHttpResponse;
    try {
      response = await this.http(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: this.role, jwt }),
      });
    } catch (cause) {
      throw new VaultAuthInternalError("vault login transport failure", { cause });
    }
    if (response.status === 403) {
      // 403 from `auth/.../login` means the K8s auth role rejected the JWT.
      throw new VaultAuthInternalError(
        "vault kubernetes auth rejected the service-account token (check role binding)",
      );
    }
    if (!response.ok) {
      throw new VaultAuthInternalError(`vault login returned status ${response.status}`);
    }
    const parsed = (await response.json()) as VaultLoginResponse;
    return this.parseAuthBlock(parsed.auth, "login");
  }

  /**
   * Token self-renewal via `auth/token/renew-self`. Returns `undefined` on
   * 403 so the caller can fall back to a full re-auth.
   */
  private async renew(current: ActiveToken): Promise<ActiveToken | undefined> {
    const url = `${this.address}/v1/auth/token/renew-self`;
    let response: VaultHttpResponse;
    try {
      response = await this.http(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vault-token": current.value,
        },
        body: JSON.stringify({}),
      });
    } catch (cause) {
      throw new VaultAuthInternalError("vault token renewal transport failure", { cause });
    }
    if (response.status === 403) {
      this.active = undefined;
      return undefined;
    }
    if (!response.ok) {
      throw new VaultAuthInternalError(`vault token renewal returned status ${response.status}`);
    }
    const parsed = (await response.json()) as VaultRenewResponse;
    const next = this.parseAuthBlock(parsed.auth, "renew");
    this.active = next;
    return next;
  }

  private async readServiceAccountToken(): Promise<string> {
    try {
      return await this.serviceAccountTokenReader.read();
    } catch (cause) {
      throw new VaultAuthInternalError("could not read kubernetes service-account token", {
        cause,
      });
    }
  }

  /**
   * Parse the `auth` block from a Vault response. The Vault API returns
   * `lease_duration` in seconds; we convert to milliseconds for the
   * internal clock.
   */
  private parseAuthBlock(
    block: VaultLoginResponse["auth"] | VaultRenewResponse["auth"],
    operation: "login" | "renew",
  ): ActiveToken {
    if (block === undefined || block === null || typeof block !== "object") {
      throw new VaultAuthInternalError(`vault ${operation} response missing auth block`);
    }
    const clientToken = block.client_token;
    const leaseDuration = block.lease_duration;
    const renewable = block.renewable;
    if (typeof clientToken !== "string" || clientToken.length === 0) {
      throw new VaultAuthInternalError(`vault ${operation} response missing client_token`);
    }
    if (
      typeof leaseDuration !== "number" ||
      !Number.isFinite(leaseDuration) ||
      leaseDuration <= 0
    ) {
      throw new VaultAuthInternalError(`vault ${operation} response has invalid lease_duration`);
    }
    const originalLeaseTtlMs = leaseDuration * 1000;
    return {
      value: clientToken,
      expiresAt: this.now() + originalLeaseTtlMs,
      originalLeaseTtlMs,
      renewable: renewable === true,
    };
  }
}
