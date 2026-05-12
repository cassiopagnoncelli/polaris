/**
 * Event queue surface for `@polaris/web-sdk`.
 *
 * Three storage layers per `docs/architecture/10-sdk-standards.md`:
 *
 *   IndexedDB preferred
 *   localStorage fallback
 *   memory fallback
 *
 * `LayeredEventQueue` orchestrates capability detection and routes
 * operations through the strongest available layer.
 *
 * The `EventQueue` interface itself lives with the other public types in
 * `../types.ts`. Cookies are NEVER used for event queues.
 */

export { IndexedDbQueue, probeIndexedDb } from "./indexeddb-queue.js";
export { LayeredEventQueue, type LayeredEventQueueOptions } from "./layered-queue.js";
export { LocalStorageQueue, type LocalStorageQueueOptions } from "./localstorage-queue.js";
export { MemoryQueue, type MemoryQueueOptions } from "./memory-queue.js";
export { pickEvictionIndex, rankOf } from "./priority.js";
