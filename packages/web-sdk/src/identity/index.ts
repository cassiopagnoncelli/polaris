/**
 * Identity persistence surface for `@polaris/web-sdk`.
 *
 * Exports the storage layer implementations, the layered store, and the
 * identity manager. The `PolarisWebSdk` class in `../sdk.ts` is the
 * canonical consumer; this module is also exported under the
 * `@polaris/web-sdk/identity` subpath so application code can wire a
 * custom storage layer or read identity diagnostics directly without
 * instantiating the full SDK.
 */

export { CookieStore } from "./cookie-store.js";
export { LayeredIdentityStore } from "./layered-store.js";
export { DEFAULT_SESSION_INACTIVITY_MS, IdentityManager } from "./manager.js";
export { MemoryStore } from "./memory-store.js";
export { deserializeIdentity, serializeIdentity } from "./serialize.js";
export {
  LocalStorageStore,
  SessionStorageStore,
  WebStorageStore,
  type WebStorageStoreInputs,
} from "./web-storage-store.js";
