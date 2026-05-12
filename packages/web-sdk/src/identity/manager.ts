/**
 * `IdentityManager` — the public surface for identity state in the Web SDK.
 *
 * Responsibilities:
 *
 *   - run capability detection at construction time and pick a primary
 *     storage layer per the doctrinal order (cookie -> localStorage ->
 *     sessionStorage -> memory) — see `docs/architecture/10-sdk-standards.md`
 *   - own `anonymous_id`, `session_id`, `customer_id` lifecycle
 *   - rotate `session_id` after 30 minutes of inactivity (configurable)
 *   - implement `identify()` and `reset()` semantics:
 *       reset()                 -> clears customer_id, rotates session_id,
 *                                  rotates anonymous_id
 *       reset({ anonymous: false }) -> clears customer_id, rotates
 *                                  session_id, keeps anonymous_id
 *   - expose diagnostic context (storage layer, capability, WebView flag)
 *     for the downstream identity resolver to weigh evidence quality
 *
 * Non-responsibilities (deferred to P3-003):
 *
 *   - the queue (IndexedDB + localStorage + memory)
 *   - the HTTPS transport
 *   - batch flush, retry, eager-flush mode
 *   - `track()` semantics
 *   - emitting identify events
 *
 * Campaign / click changes do NOT rotate sessions. The doc treats those
 * as event context (`context.campaign.*`) rather than identity. The SDK
 * is not an attribution engine.
 */

import {
  detectWebView,
  getLocalStorage,
  getSessionStorage,
  isSecureContext,
  resolveDocument,
  resolveWindow,
} from "../internal/environment.js";
import { newIdentityId } from "../internal/ids.js";
import type {
  EnvelopeIdentity,
  IdentifyTraits,
  IdentityCapability,
  IdentityDiagnostics,
  IdentityManagerOptions,
  IdentityStore,
  PersistedIdentity,
  ResetOptions,
  StorageLayer,
} from "../types.js";
import { CookieStore } from "./cookie-store.js";
import { LayeredIdentityStore } from "./layered-store.js";
import { MemoryStore } from "./memory-store.js";
import { LocalStorageStore, SessionStorageStore } from "./web-storage-store.js";

const DEFAULT_STORAGE_ORDER: readonly StorageLayer[] = [
  "cookie",
  "localStorage",
  "sessionStorage",
  "memory",
];

/** Default session inactivity timeout — 30 minutes per the architecture doc. */
export const DEFAULT_SESSION_INACTIVITY_MS = 30 * 60 * 1000;

export class IdentityManager {
  private readonly store: LayeredIdentityStore;
  private readonly capability: IdentityCapability;
  private readonly sessionInactivityMs: number;
  private readonly clock: () => number;
  private readonly mintId: (prefix: "anon" | "sess") => string;
  private snapshot: PersistedIdentity;

  public constructor(options: IdentityManagerOptions = {}) {
    if (options.sessionInactivityMs !== undefined) {
      if (!Number.isFinite(options.sessionInactivityMs) || options.sessionInactivityMs <= 0) {
        throw new Error("IdentityManager: sessionInactivityMs must be a finite positive number");
      }
    }

    this.sessionInactivityMs = options.sessionInactivityMs ?? DEFAULT_SESSION_INACTIVITY_MS;
    this.clock = options.now ?? Date.now;
    this.mintId = options.idGenerator ?? newIdentityId;

    const doc = resolveDocument(options.document);
    const win = resolveWindow(options.window);
    const localStorage = getLocalStorage(win);
    const sessionStorage = getSessionStorage(win);
    const secureContext = isSecureContext(win);
    const webview = detectWebView(win);

    const cookieStore = new CookieStore({
      document: doc,
      options: options.cookie,
      secureContext,
    });
    const localStorageStore = new LocalStorageStore({ storage: localStorage });
    const sessionStorageStore = new SessionStorageStore({ storage: sessionStorage });
    const memoryStore = new MemoryStore();

    const storeByLayer: Record<StorageLayer, IdentityStore> = {
      cookie: cookieStore,
      localStorage: localStorageStore,
      sessionStorage: sessionStorageStore,
      memory: memoryStore,
    };

    const order = options.storageOrder ?? DEFAULT_STORAGE_ORDER;
    const stores = order.map((layer) => storeByLayer[layer]);

    const available: StorageLayer[] = [];
    let primary: StorageLayer = "memory";
    for (const store of stores) {
      if (store.isAvailable()) {
        available.push(store.layer);
        if (available.length === 1) {
          primary = store.layer;
        }
      }
    }
    if (available.length === 0) {
      // The memory store is always available; this branch only fires if
      // the caller passed a custom storageOrder that omits memory.
      available.push("memory");
      primary = "memory";
      stores.push(memoryStore);
    }

    const degraded = primary === "memory" || primary === "sessionStorage";

    this.capability = Object.freeze({
      available: Object.freeze([...available]),
      primary,
      degraded,
      webview,
      secureContext,
    });

    // Mirror layer: localStorage when localStorage is available *and*
    // localStorage is not itself the canonical layer. This enforces the
    // doctrinal "anonymous_id mirrored into localStorage when available"
    // rule from the architecture doc.
    const mirrorLayer: StorageLayer | undefined =
      available.includes("localStorage") && primary !== "localStorage" ? "localStorage" : undefined;

    this.store = new LayeredIdentityStore({
      stores,
      capability: this.capability,
      mirrorLayer,
    });

    this.snapshot = this.hydrateOrInitialize();
  }

  /** Capability detection result captured at construction. */
  public getCapability(): IdentityCapability {
    return this.capability;
  }

  /** Diagnostic snapshot for the identity layer. */
  public getDiagnostics(): IdentityDiagnostics {
    return Object.freeze({
      capability: this.capability,
      currentLayer: this.store.getCurrentLayer(),
      lastActivityAt: this.snapshot.last_activity_at,
    });
  }

  /** Current `anonymous_id`. Rotates a session first if 30 minutes have elapsed. */
  public getAnonymousId(): string {
    this.maybeRotateSession();
    return this.snapshot.anonymous_id;
  }

  /** Current `session_id`. Rotates first if 30 minutes have elapsed. */
  public getSessionId(): string {
    this.maybeRotateSession();
    return this.snapshot.session_id;
  }

  /** Current `customer_id` (null when no `identify()` has been called). */
  public getCustomerId(): string | null {
    return this.snapshot.customer_id;
  }

  /** Frozen snapshot of the identity record for diagnostics/logging. */
  public getIdentity(): Readonly<PersistedIdentity> {
    this.maybeRotateSession();
    return Object.freeze({ ...this.snapshot });
  }

  /** Envelope-shaped identity for inclusion in events (P3-003 consumes this). */
  public toEnvelopeIdentity(): EnvelopeIdentity {
    this.maybeRotateSession();
    return {
      anonymous_id: this.snapshot.anonymous_id,
      session_id: this.snapshot.session_id,
      customer_id: this.snapshot.customer_id,
      device_id: null,
    };
  }

  /**
   * Mark SDK activity so the 30-minute inactivity clock resets. Called
   * from `track()` (in P3-003) and from `identify()`. Public so callers
   * that want to mark explicit activity outside `track()` can do so.
   */
  public touch(): void {
    this.maybeRotateSession();
    this.commit({ ...this.snapshot, last_activity_at: this.clock() });
  }

  /**
   * Associate a `customer_id` with subsequent events. Does not auto-emit
   * an `identify` event — the Web SDK is a transport + identity helper,
   * not an analytics engine. The downstream identity resolver picks up
   * the link from the `anonymous_id + customer_id` overlap on the next
   * event, which is the authoritative link signal.
   *
   * `traits` is accepted to match the architecture-doc shape; v1 does
   * not store traits in identity. Future versions may emit an explicit
   * identify event when an authoritative catalog entry exists.
   */
  public identify(customerId: string, _traits?: IdentifyTraits): void {
    assertValidCustomerId(customerId);
    this.maybeRotateSession();
    this.commit({
      ...this.snapshot,
      customer_id: customerId,
      last_activity_at: this.clock(),
    });
  }

  /**
   * Per the architecture doc:
   *
   *   reset()                         -> clears customer_id,
   *                                      rotates session_id,
   *                                      rotates anonymous_id
   *   reset({ anonymous: false })     -> clears customer_id,
   *                                      rotates session_id,
   *                                      keeps anonymous_id
   *
   * The default favours shared-device/logout safety; the opt-out exists
   * for products that deliberately want anonymous continuity across
   * logout.
   */
  public reset(options?: ResetOptions): void {
    const rotateAnonymous = options?.anonymous !== false;
    const now = this.clock();
    this.commit({
      anonymous_id: rotateAnonymous ? this.mintId("anon") : this.snapshot.anonymous_id,
      session_id: this.mintId("sess"),
      customer_id: null,
      last_activity_at: now,
      storage_layer: this.snapshot.storage_layer,
    });
  }

  /**
   * Force-rotate the session even though the inactivity threshold has
   * not been crossed. Intended for explicit SDK lifecycle hooks (P3-003
   * may call this on certain auth-state transitions); production code
   * should prefer the implicit inactivity-driven rotation in `touch()`.
   */
  public rotateSession(): void {
    const now = this.clock();
    this.commit({
      ...this.snapshot,
      session_id: this.mintId("sess"),
      last_activity_at: now,
    });
  }

  // --- internal --------------------------------------------------------

  private hydrateOrInitialize(): PersistedIdentity {
    const existing = this.store.read();
    const now = this.clock();
    if (existing !== null) {
      // Apply session inactivity rotation to the hydrated record so a
      // user returning after >30 minutes immediately gets a fresh session
      // id, even before the first `touch()`.
      const elapsed = now - existing.last_activity_at;
      if (elapsed >= this.sessionInactivityMs) {
        const rotated: PersistedIdentity = {
          ...existing,
          session_id: this.mintId("sess"),
          last_activity_at: now,
        };
        this.commit(rotated);
        return rotated;
      }
      // Refresh storage_layer to reflect where we just read from; the
      // layered store also re-stamps this on every write.
      return existing;
    }
    const fresh: PersistedIdentity = {
      anonymous_id: this.mintId("anon"),
      session_id: this.mintId("sess"),
      customer_id: null,
      last_activity_at: now,
      storage_layer: this.capability.primary,
    };
    this.commit(fresh);
    return fresh;
  }

  private maybeRotateSession(): void {
    const now = this.clock();
    const elapsed = now - this.snapshot.last_activity_at;
    if (elapsed >= this.sessionInactivityMs) {
      this.commit({
        ...this.snapshot,
        session_id: this.mintId("sess"),
        last_activity_at: now,
      });
    }
  }

  private commit(identity: PersistedIdentity): void {
    const landed = this.store.write(identity);
    this.snapshot = { ...identity, storage_layer: landed };
  }
}

/**
 * Customer-ID input validation shared between Web SDK and Node SDK.
 *
 * The architecture doc constrains the canonical envelope to non-empty
 * strings up to 128 characters; we surface that here so producers get a
 * synchronous error rather than a delayed ingester rejection. The Node
 * SDK has its own copy of this; the Web SDK keeps it local to avoid
 * pulling the Node SDK as a runtime dep.
 */
function assertValidCustomerId(customerId: unknown): asserts customerId is string {
  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new Error("IdentityManager.identify: customerId must be a non-empty string");
  }
  if (customerId.length > 128) {
    throw new Error("IdentityManager.identify: customerId exceeds 128 characters");
  }
}
