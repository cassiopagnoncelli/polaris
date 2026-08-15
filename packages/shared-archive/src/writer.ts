/**
 * Turning closed batches into objects.
 *
 * One method: `flush`. It takes whatever the batcher considers due, puts
 * each batch, appends a manifest line, and settles the batch so the
 * watermark — and behind it the checkpoint — can advance. A batch whose
 * put fails goes back to the batcher and is retried on the next pass,
 * with its watermark still held.
 *
 * ## Order within a flush: object first, manifest second
 *
 * A manifest line pointing at an object that does not exist would make a
 * replay try to GET a missing key. A manifest MISSING a line for an
 * object that does exist costs a fallback listing and nothing else (see
 * `manifest.ts`). Between the two failure shapes the second is strictly
 * cheaper, so the object is written first and the manifest is best-effort
 * after it.
 *
 * The batch is settled after the object put, not after the manifest.
 * Durability is a property of the object; the manifest is an index.
 *
 * ## Flushes do not overlap
 *
 * A second `flush` while one is running would let two puts race for the
 * same manifest key and lose a line — read-modify-write is only safe with
 * one writer, and "one writer" has to include one writer at a time. The
 * in-progress flush is returned to a concurrent caller instead.
 */

import { type ArchiveBatch, ArchiveBatcher } from "./batcher.js";
import { archiveBatchKey } from "./layout.js";
import {
  type ArchiveManifestEntry,
  archiveStreamManifestKey,
  parseManifest,
  renderManifest,
} from "./manifest.js";
import type { ArchiveObjectStore } from "./object-store.js";

export interface ArchiveWriterOptions {
  readonly store: ArchiveObjectStore;
  readonly batcher: ArchiveBatcher;
  readonly prefix: string;
  readonly now: () => Date;
  /** Called once per successfully written object. */
  readonly onWritten?: (input: {
    readonly key: string;
    readonly records: number;
    readonly bytes: number;
    readonly projectId: string;
    readonly environment: string;
  }) => void;
  /**
   * Called when a put failed and the batch was requeued. The checkpoint
   * is being held back for as long as this keeps happening, so this is
   * the alert-worthy one.
   */
  readonly onFailed?: (input: {
    readonly key: string;
    readonly records: number;
    readonly err: unknown;
  }) => void;
  /** Called when the object landed but its manifest line did not. */
  readonly onManifestFailed?: (input: { readonly key: string; readonly err: unknown }) => void;
}

export interface ArchiveFlushResult {
  readonly objectsWritten: number;
  readonly recordsWritten: number;
  readonly batchesFailed: number;
}

export interface ArchiveWriter {
  /** Write every batch the batcher considers due. */
  flush(nowMs: number, force?: boolean): Promise<ArchiveFlushResult>;
}

export function createArchiveWriter(options: ArchiveWriterOptions): ArchiveWriter {
  const { store, batcher, prefix } = options;
  let inProgress: Promise<ArchiveFlushResult> | null = null;

  async function writeBatch(batch: ArchiveBatch): Promise<boolean> {
    const key = archiveBatchKey({
      prefix,
      projectId: batch.projectId,
      environment: batch.environment,
      date: batch.date,
      stream: batch.stream,
      firstOffset: batch.firstOffset,
      lastOffset: batch.lastOffset,
    });

    try {
      await store.put({ key, body: ArchiveBatcher.render(batch) });
    } catch (err) {
      // Back to the batcher, watermark still held. The events are not
      // lost — they are still in memory, and the checkpoint has not moved
      // past them, so even a crash now replays them from the stream.
      batcher.requeue(batch);
      options.onFailed?.({ key, records: batch.records.length, err });
      return false;
    }

    // Durable. The watermark may advance past this batch now, whatever
    // the manifest does next.
    batcher.settle(batch);
    options.onWritten?.({
      key,
      records: batch.records.length,
      bytes: batch.bytes,
      projectId: batch.projectId,
      environment: batch.environment,
    });

    try {
      await appendManifest(batch, key);
    } catch (err) {
      // Best effort by design: a day whose manifest is incomplete costs
      // the reader a listing, and the events are already safe.
      options.onManifestFailed?.({ key, err });
    }
    return true;
  }

  async function appendManifest(batch: ArchiveBatch, objectKey: string): Promise<void> {
    const manifestKey = archiveStreamManifestKey({
      prefix,
      projectId: batch.projectId,
      environment: batch.environment,
      date: batch.date,
      stream: batch.stream,
    });
    const existing = await store.get(manifestKey);
    const entries: ArchiveManifestEntry[] = existing === null ? [] : [...parseManifest(existing)];
    const times = batch.records
      .map((record) => Date.parse(occurredAtOf(record.line) ?? ""))
      .filter((ms) => Number.isFinite(ms));
    const min = times.length > 0 ? Math.min(...times) : options.now().getTime();
    const max = times.length > 0 ? Math.max(...times) : options.now().getTime();

    entries.push({
      key: objectKey,
      first_offset: batch.firstOffset,
      last_offset: batch.lastOffset,
      min_occurred_at: new Date(min).toISOString(),
      max_occurred_at: new Date(max).toISOString(),
      records: batch.records.length,
      bytes: batch.bytes,
      written_at: options.now().toISOString(),
    });
    await store.put({ key: manifestKey, body: renderManifest(entries) });
  }

  return {
    flush(nowMs: number, force = false): Promise<ArchiveFlushResult> {
      if (inProgress !== null) return inProgress;
      const run = (async (): Promise<ArchiveFlushResult> => {
        const due = batcher.takeDue(nowMs, force);
        let objects = 0;
        let records = 0;
        let failed = 0;
        for (const batch of due) {
          const ok = await writeBatch(batch);
          if (ok) {
            objects += 1;
            records += batch.records.length;
          } else {
            failed += 1;
          }
        }
        return { objectsWritten: objects, recordsWritten: records, batchesFailed: failed };
      })();
      inProgress = run;
      return run.finally(() => {
        inProgress = null;
      });
    },
  };
}

/** `occurred_at` from an archived line, without parsing the whole envelope twice. */
function occurredAtOf(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const at = parsed["occurred_at"];
    return typeof at === "string" ? at : null;
  } catch {
    return null;
  }
}
