/**
 * Public types for `@polaris/web-sdk`.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - SDKs are thin transport + identity/session helpers, not analytics
 *     engines. The Web SDK does not enrich, attribute, resolve identity,
 *     call vendors, or own schema governance.
 *   - Browser identity persistence is layered: first-party cookie ->
 *     localStorage mirror -> sessionStorage fallback -> in-memory fallback.
 *   - No third-party cookies. No fingerprinting. No IP-based identity
 *     inference.
 *   - Sessions rotate after 30 minutes of inactivity. Campaign / click
 *     changes do NOT rotate sessions — they are captured as event context,
 *     not identity.
 *   - `reset()` defaults to stronger user separation: clears customer_id,
 *     rotates session_id, rotates anonymous_id. `reset({ anonymous: false
 *     })` keeps anonymous_id.
 *   - The SDK records the storage layer it landed on as diagnostic context
 *     so the downstream identity resolver can treat storage layer as
 *     evidence quality.
 *
 * This task (P3-002) ships the identity-persistence layer only. The queue,
 * transport, batch flush, retry, and `track()` semantics are P3-003. A
 * minimal `WebSdkOptions` is defined here so the manager can be wired into
 * a public surface stub in P3-003 without rework.
 */

import type { Envelope } from "@polaris/shared-schemas";

/**
 * Layers the SDK considers when reading/writing identity.
 *
 * Order in the array is the doctrinal fallback chain:
 *   first-party cookie  -> stronger browser continuity signal
 *   localStorage mirror -> normal browser continuity signal
 *   sessionStorage      -> weaker session-only signal
 *   in-memory           -> weakest transient signal
 *
 * The identity resolver downstream treats this enum as an evidence-quality
 * signal (see `docs/architecture/10-sdk-standards.md` § Identity Resolution
 * Coupling).
 */
export type StorageLayer = "cookie" | "localStorage" | "sessionStorage" | "memory";

/**
 * Result of capability detection at SDK init. Recorded for diagnostics and
 * surfaced via {@link IdentityManager.getDiagnostics}. `available` is the
 * list of layers the SDK successfully probed at startup; `primary` is the
 * highest-priority layer actually selected for writes. `degraded` is true
 * when the SDK ended up on an in-memory or session-only layer because the
 * stronger options were unavailable (typical for ad WebViews / locked-down
 * Safari modes / private browsing).
 */
export interface IdentityCapability {
  readonly available: readonly StorageLayer[];
  readonly primary: StorageLayer;
  readonly degraded: boolean;
  /** True when running in a detected WebView / in-app browser. */
  readonly webview: boolean;
  /** True when the page is loaded over `https:`. Drives the Secure cookie flag. */
  readonly secureContext: boolean;
}

/** Configuration for the cookie layer. Defaults follow the architecture doc. */
export interface CookieOptions {
  /**
   * Cookie name used for the identity record. Defaults to `polaris_id`. The
   * SDK uses a single cookie and JSON-encodes the identity payload inside
   * it so we do not pollute the cookie jar with one cookie per field.
   */
  readonly name?: string;
  /**
   * Cookie `Domain` attribute. Leave unset to scope to the current host
   * (browser default). Set to `.example.com` to share identity across
   * subdomains.
   */
  readonly domain?: string;
  /**
   * Cookie `Path` attribute. Defaults to `/`. Only set this when you
   * deliberately want to scope identity to a subpath.
   */
  readonly path?: string;
  /**
   * Cookie `Max-Age` in seconds. Defaults to 13 months (matches the GDPR
   * cookie convention used by most analytics SDKs).
   */
  readonly maxAgeSeconds?: number;
  /**
   * Cookie `SameSite` attribute. Defaults to `Lax`. We intentionally do
   * not expose `None` as a default — third-party cookie use is forbidden.
   */
  readonly sameSite?: "Lax" | "Strict";
  /**
   * When `undefined` (the default) the SDK adds `Secure` if and only if
   * the page is loaded over HTTPS. Set to `true` to force `Secure`, set to
   * `false` to suppress it (only useful for local HTTP development).
   */
  readonly secure?: boolean;
}

/** Storage interface every identity layer implements. */
export interface IdentityStore {
  /** Stable label used in diagnostics. */
  readonly layer: StorageLayer;
  /**
   * Synchronous availability check. Stores that talk to the DOM probe
   * the relevant APIs in `isAvailable`; the layered store calls this once
   * at construction and a second time before each operation so a tab that
   * loses storage access (e.g. iOS Safari evicting site data) is detected
   * without crashing the SDK.
   */
  isAvailable(): boolean;
  /** Read the identity record. Returns null when nothing is stored. */
  read(): PersistedIdentity | null;
  /** Write the identity record. Returns false if the underlying store rejected the write. */
  write(identity: PersistedIdentity): boolean;
  /** Clear the identity record. Returns false if the underlying store rejected the clear. */
  clear(): boolean;
}

/**
 * Identity record shape persisted to whichever storage layer is available.
 *
 * `last_activity_at` is an epoch millisecond timestamp the SDK uses for
 * 30-minute inactivity session rotation. Storing it next to the IDs keeps
 * a layered read self-contained — a fresh tab on a different storage layer
 * can still rotate correctly without consulting other layers.
 *
 * `storage_layer` is the layer the record was last written through. The
 * SDK uses this for diagnostics and to surface evidence quality to the
 * downstream identity resolver.
 */
export interface PersistedIdentity {
  readonly anonymous_id: string;
  readonly session_id: string;
  readonly customer_id: string | null;
  /** Epoch millis of the most recent SDK activity that touched identity. */
  readonly last_activity_at: number;
  /** Layer this snapshot was written through. */
  readonly storage_layer: StorageLayer;
}

/** Identity fields surfaced to event envelopes. */
export type EnvelopeIdentity = Envelope["identity"];

/** Options accepted by `reset()`. */
export interface ResetOptions {
  /**
   * Default `true` — rotate `anonymous_id` along with `customer_id` /
   * `session_id`. Set `false` to keep anonymous continuity (matches the
   * Node SDK shape so application code reads the same on both runtimes).
   */
  readonly anonymous?: boolean;
}

/** Optional identity traits attached by `identify()`. Mirrors the Node SDK. */
export type IdentifyTraits = Readonly<Record<string, unknown>>;

/** Options for the layered identity store / manager. */
export interface IdentityManagerOptions {
  /** Configuration for the cookie layer. */
  readonly cookie?: CookieOptions;
  /**
   * Override the storage-layer chain considered at startup. The first
   * available layer in this list wins. Defaults to the doctrinal order:
   * `["cookie", "localStorage", "sessionStorage", "memory"]`.
   */
  readonly storageOrder?: readonly StorageLayer[];
  /**
   * Session inactivity timeout in milliseconds. Defaults to 30 minutes,
   * which matches the architecture doc. The Web SDK does not rotate
   * sessions on campaign or click-id changes — those are event context.
   */
  readonly sessionInactivityMs?: number;
  /**
   * Optional `Date.now`-style clock injected for tests. Production code
   * uses the system clock; tests pin time to assert inactivity-rotation
   * timing without `vi.useFakeTimers`.
   */
  readonly now?: () => number;
  /**
   * Optional ID generator. Tests can inject deterministic IDs; production
   * uses UUIDv7 with a stable `anon_` / `sess_` prefix.
   */
  readonly idGenerator?: (prefix: "anon" | "sess") => string;
  /**
   * Optional document/window pair injected for tests in non-DOM contexts
   * (the package is browser-targeted; happy-dom supplies these in tests).
   * If omitted, the SDK reads from `globalThis`.
   */
  readonly document?: Document | undefined;
  readonly window?: Window | undefined;
}

/**
 * Diagnostic snapshot exposed via {@link IdentityManager.getDiagnostics}.
 *
 * The Web SDK does NOT emit automatic diagnostic events to Polaris in v1
 * (per `10-sdk-standards.md`). This snapshot exists so application code
 * can read storage-layer fallback state, log it locally, or forward it
 * via an opt-in diagnostic stream wired up in P3-003.
 */
export interface IdentityDiagnostics {
  readonly capability: IdentityCapability;
  /** Layer the last write actually landed on. Equals `capability.primary` after a successful write. */
  readonly currentLayer: StorageLayer;
  /** Epoch millis of the most recent identity touch. */
  readonly lastActivityAt: number;
}

/**
 * Web SDK constructor options surface — placeholder for P3-003.
 *
 * P3-002 ships only the identity layer, so the SDK class itself is a
 * minimal stub that wires the identity manager and exposes the public
 * `track`/`identify`/`reset`/`flush` shape. The queue, transport, batch
 * flush, retry, and `track()` semantics land in P3-003 (Web SDK Queue and
 * Transport). Anything beyond identity here is a placeholder so that
 * P3-003 lands cleanly.
 */
export interface WebSdkOptions {
  /** Polaris ingestion endpoint. Required in P3-003; ignored in P3-002. */
  readonly endpoint?: string;
  /** API key bound to project/environment/source by the control plane. */
  readonly apiKey?: string;
  /** Identity manager options forwarded to the layered identity store. */
  readonly identity?: IdentityManagerOptions;
}
