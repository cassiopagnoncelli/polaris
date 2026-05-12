/**
 * `@polaris/web-sdk` — browser SDK for Polaris.
 *
 * P3-002 ships the identity-persistence layer only:
 *
 *   - `IdentityStore` interface and four implementations: `CookieStore`,
 *     `LocalStorageStore`, `SessionStorageStore`, `MemoryStore`.
 *   - `LayeredIdentityStore` orchestrating the doctrinal fallback chain
 *     (cookie -> localStorage -> sessionStorage -> memory).
 *   - `IdentityManager` exposing get/set for `anonymous_id`, `session_id`,
 *     `customer_id`, plus 30-minute session inactivity rotation and the
 *     `reset()` semantics from the architecture doc.
 *   - `PolarisWebSdk` class as the public-surface stub. Identity methods
 *     are fully wired; `track()` and `flush()` are placeholders that
 *     land in P3-003.
 *
 * Hard rules baked in (per `docs/architecture/10-sdk-standards.md`):
 *
 *   - No third-party cookies. No fingerprinting. No IP-based identity
 *     inference.
 *   - First-party cookie uses `SameSite=Lax` and adds `Secure` when the
 *     page is served over HTTPS. Cookie domain is configurable for
 *     subdomain sharing.
 *   - `anonymous_id` is mirrored into localStorage when available, so
 *     identity survives a Safari ITP cookie eviction.
 *   - Sessions rotate after 30 minutes of inactivity. Campaign / click
 *     changes do NOT rotate sessions — those are event context.
 *   - WebView / in-app browser environments are detected and surfaced
 *     as diagnostic context. Support is best-effort, not guaranteed.
 *   - SDK records the storage layer it landed on as diagnostic context
 *     so the downstream identity resolver can treat the layer as
 *     evidence quality.
 *
 * Out of scope (P3-003):
 *
 *   - the queue (IndexedDB + localStorage + memory)
 *   - the HTTPS transport
 *   - batch flush, retry, eager-flush mode
 *   - `track()` semantics
 *   - the script-tag loader + IIFE bundle
 *
 * @see docs/architecture/04-ingestion-and-sdks.md
 * @see docs/architecture/10-sdk-standards.md
 * @see docs/implementation/tasks/P3-002-web-sdk-identity-persistence.md
 */

export {
  CookieStore,
  DEFAULT_SESSION_INACTIVITY_MS,
  IdentityManager,
  LayeredIdentityStore,
  LocalStorageStore,
  MemoryStore,
  SessionStorageStore,
  WebStorageStore,
  type WebStorageStoreInputs,
} from "./identity/index.js";
export { PolarisWebSdk } from "./sdk.js";
export type {
  CookieOptions,
  EnvelopeIdentity,
  IdentifyTraits,
  IdentityCapability,
  IdentityDiagnostics,
  IdentityManagerOptions,
  IdentityStore,
  PersistedIdentity,
  ResetOptions,
  StorageLayer,
  WebSdkOptions,
} from "./types.js";
