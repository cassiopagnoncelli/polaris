/**
 * `@polaris/merge-worker-v1` public surface.
 *
 * The pure mapping logic is exported because it is the part worth testing
 * and reusing — `polaris profiles rebuild` will need the same chain-collapse
 * rule when it replays merges.
 */

export { type BuildAppOptions, type BuiltMergeWorkerApp, buildMergeWorkerApp } from "./app.js";
export { loadMergeWorkerConfig, type MergeWorkerRuntimeConfig } from "./config.js";
export { buildMergeRows, isActionableMerge, type MergeEvent } from "./merge-map.js";
export { createMergeHandler, type MergeWorkerRuntimeInput } from "./runtime.js";
