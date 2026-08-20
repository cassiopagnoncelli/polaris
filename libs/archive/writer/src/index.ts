/**
 * `@polaris/shared-archive` — the raw.events archive.
 *
 * Everything that knows the archive's shape lives here: the object
 * layout, the batching and durability watermark the archiver writes
 * with, and the replay source that reads it back. The running service is
 * `async/warehouse/archiver/v1`; this package is what it and the CLI's
 * replay wiring both depend on, so the writer and the reader cannot
 * disagree about where an object is.
 */

export {
  type ArchiveBatch,
  ArchiveBatcher,
  type ArchiveBatcherLimits,
  type ArchiveRecord,
} from "./batcher.js";
export {
  createDeferredCheckpointStore,
  type DeferredCheckpointStoreOptions,
} from "./deferred-checkpoints.js";
// The layout's public face is two functions and two types. Everything
// else about where an object lives is internal, and deliberately: the
// writer and the replay source share this module precisely so that no
// third party can form a key, because a key formed anywhere else is a key
// that drifts — and the failure is silent, since a replay that finds
// nothing looks exactly like a window with no events.
export {
  type ArchiveBatchKeyInput,
  archiveDateOf,
  type ParsedArchiveKey,
  parseArchiveBatchKey,
} from "./layout.js";
export type { ArchiveManifestEntry } from "./manifest.js";
export {
  type ArchiveObjectStore,
  type ArchiveObjectSummary,
  createInMemoryArchiveStore,
  createS3ArchiveStore,
  type S3ArchiveStoreOptions,
  type S3Commands,
  type S3GetInput,
  type S3Like,
  type S3ListInput,
  type S3PutInput,
} from "./object-store.js";
export {
  type ArchivedReplayEvent,
  type ArchiveReplayChunk,
  type ArchiveReplayScope,
  type ArchiveReplaySource,
  type ArchiveReplaySourceOptions,
  createArchiveReplaySource,
} from "./replay-source.js";
export {
  type ArchiveFlushResult,
  type ArchiveWriter,
  type ArchiveWriterOptions,
  createArchiveWriter,
} from "./writer.js";
