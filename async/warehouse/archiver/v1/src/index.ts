/**
 * archiver v1 — `raw.events` to object storage.
 *
 * The stream holds ninety days. This holds the rest, so a profile rebuild
 * can reach further back than the window and a five-year customer does
 * not come out of an un-merge with a `first_seen_at` of last quarter.
 */

export { buildArchiverApp, PROCESSOR_COMPONENT, PROCESSOR_VERSION } from "./app.js";
export { type ArchiverRuntimeConfig, archiverConfigSchema, loadArchiverConfig } from "./config.js";
export { createArchiveHandler, type FlushLoop, startFlushLoop } from "./runtime.js";
