/**
 * Vault Agent sidecar token source (DCJXEFE5).
 *
 * In the Vault Agent sidecar pattern, a co-located Agent container
 * (typically `hashicorp/vault` running with `vault agent`) owns the
 * Kubernetes-auth flow itself. The Agent exchanges the pod's
 * service-account JWT for a Vault client token, renews it on schedule,
 * and writes the current token to a file on a shared `emptyDir`
 * volume:
 *
 *   /vault/secrets/token              (Polaris convention)
 *
 * Polaris reads that file via this source. We never see the K8s SA
 * token, never call `auth/<mount>/login`, and never run a renewal
 * timer. The trade-off relative to the direct K8s auth flow that
 * {@link VaultTokenManager} implements:
 *
 *   - **Simpler K8s RBAC.** The Agent's role binding owns the auth
 *     surface; the Polaris pod's service account does not need a Vault
 *     auth-role mapping at all.
 *   - **More moving parts.** An extra container per pod, an extra
 *     volume, and a deployment / kustomize change. Operators trading
 *     auth complexity for orchestration complexity.
 *
 * The source is config-flag gated on the provider (`auth: "agent"`);
 * the v1 default stays at direct K8s auth so existing deployments
 * keep working unchanged.
 *
 * Behavior:
 *
 *   - Reads the token file on first use and caches the value in
 *     memory.
 *   - Re-reads on every `token()` call if the cached value is older
 *     than `rereadIntervalMs` (default: 30s). The Agent typically
 *     rewrites the file on lease renewal (every minute or so at
 *     typical lease windows), so the re-read interval keeps the
 *     cached token fresh without thrashing the filesystem.
 *   - `invalidate()` clears the cached value; the next `token()`
 *     reads from disk immediately.
 *   - `lease()` returns `undefined`: the Agent owns the lease and
 *     does not expose its metadata to the source. The provider's
 *     readiness probe still works — `lease()` is a diagnostic
 *     accessor, not a freshness gate.
 *
 * Failures (file missing / empty / unreadable) throw
 * `VaultAuthInternalError`. The outer provider wraps that into
 * `SecretProviderError`. Token bytes never appear in any log line
 * or error message.
 */

import { readFile } from "node:fs/promises";

import { VaultAuthInternalError, type VaultTokenSource } from "./vault-token-manager.js";

/**
 * Default re-read interval. 30 seconds is short enough to pick up an
 * Agent-driven rotation within one cache cycle of the typical 1-minute
 * lease window, and long enough that we are not hitting the
 * filesystem on every KV read.
 */
export const DEFAULT_AGENT_REREAD_INTERVAL_MS = 30_000;

/**
 * Options for the Vault Agent token source.
 */
export interface VaultAgentTokenSourceOptions {
  /**
   * Path to the file the Vault Agent writes the current client token
   * to. **Required.** Conventionally `/vault/secrets/token` in
   * Polaris production deployments.
   */
  readonly tokenPath: string;
  /**
   * How long to cache the in-memory copy before re-reading the file.
   * Defaults to {@link DEFAULT_AGENT_REREAD_INTERVAL_MS}.
   *
   * Setting this to `0` forces a re-read on every `token()` call;
   * useful in tests but undesirable in production because the
   * filesystem is otherwise cold.
   */
  readonly rereadIntervalMs?: number;
  /**
   * Clock override for the re-read interval check. Defaults to
   * `Date.now`; tests inject a fake clock.
   */
  readonly now?: () => number;
  /**
   * File reader override. Defaults to `node:fs/promises#readFile`
   * with UTF-8 encoding. Tests inject an in-memory reader so they
   * never touch the real filesystem.
   */
  readonly readToken?: (path: string) => Promise<string>;
}

interface CachedToken {
  readonly value: string;
  /** Epoch ms when the file was last read. */
  readonly readAt: number;
}

/**
 * Vault Agent sidecar token source. See module comment.
 */
export class VaultAgentTokenSource implements VaultTokenSource {
  private readonly tokenPath: string;
  private readonly rereadIntervalMs: number;
  private readonly now: () => number;
  private readonly readToken: (path: string) => Promise<string>;

  private cached: CachedToken | undefined = undefined;
  private inflight: Promise<CachedToken> | undefined = undefined;

  constructor(options: VaultAgentTokenSourceOptions) {
    if (typeof options.tokenPath !== "string" || options.tokenPath.length === 0) {
      throw new TypeError("VaultAgentTokenSource: tokenPath is required");
    }
    const rereadIntervalMs = options.rereadIntervalMs ?? DEFAULT_AGENT_REREAD_INTERVAL_MS;
    if (
      typeof rereadIntervalMs !== "number" ||
      !Number.isFinite(rereadIntervalMs) ||
      rereadIntervalMs < 0
    ) {
      throw new TypeError(
        "VaultAgentTokenSource: rereadIntervalMs must be a finite non-negative number",
      );
    }
    this.tokenPath = options.tokenPath;
    this.rereadIntervalMs = rereadIntervalMs;
    this.now = options.now ?? (() => Date.now());
    this.readToken = options.readToken ?? defaultReadToken;
  }

  public async token(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && this.now() - cached.readAt < this.rereadIntervalMs) {
      return cached.value;
    }
    const fresh = await this.runOrJoin();
    return fresh.value;
  }

  public invalidate(): void {
    this.cached = undefined;
  }

  public lease(): { expiresAt: number; renewable: boolean } | undefined {
    // The Agent owns the lease window; the source does not have it.
    // Returning `undefined` is the documented contract.
    return undefined;
  }

  private async runOrJoin(): Promise<CachedToken> {
    if (this.inflight !== undefined) {
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        const next = await this.readFresh();
        this.cached = next;
        return next;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private async readFresh(): Promise<CachedToken> {
    let raw: string;
    try {
      raw = await this.readToken(this.tokenPath);
    } catch (cause) {
      throw new VaultAuthInternalError("could not read vault agent token file", { cause });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new VaultAuthInternalError("vault agent token file is empty");
    }
    return { value: trimmed, readAt: this.now() };
  }
}

/**
 * Default file reader. Pulled out so the source can be constructed
 * without taking `node:fs/promises` at the call site (tests inject a
 * fake reader and never touch the FS).
 */
async function defaultReadToken(path: string): Promise<string> {
  return await readFile(path, "utf8");
}
