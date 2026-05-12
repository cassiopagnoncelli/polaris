/**
 * Queue adapter surface for `@polaris/node-sdk`.
 *
 * The `QueueAdapter` interface itself lives with the other public types
 * in `../types.ts`. This module is the entry point for the bundled
 * adapter (memory) and any future first-party adapters.
 *
 * Durable adapters (Redis, filesystem, custom) are explicitly not part of
 * v1 per the task card. Operators that need crash-safe queueing should
 * implement `QueueAdapter` in their own application code or wait for a
 * future first-party adapter.
 */

export { MemoryQueueAdapter, type MemoryQueueOptions } from "./memory.js";
