/**
 * Batch accumulation and the durability watermark.
 *
 * Pure: no I/O, no timers, no clock of its own. The caller supplies `now`
 * and performs the puts. This is what makes "a crash loses nothing"
 * testable without a bucket — the property lives in the watermark
 * arithmetic, and the arithmetic is here.
 *
 * ## The watermark is the whole point
 *
 * The consumer checkpoints after a handler returns. An archiver whose
 * handler buffers into memory and returns has told the consumer "this
 * message is processed" while the only copy is in RAM, and a crash then
 * loses every buffered event — the checkpoint says they were handled and
 * the archive does not contain them. Nothing about that failure is
 * visible: the objects that were never written leave no gap to notice,
 * because a gap is defined by what should have been there.
 *
 * So the archiver does not let the checkpoint outrun the archive. It
 * publishes, per stream, the highest offset whose events are all in
 * object storage, and the checkpoint store clamps to it (see
 * `deferred-checkpoints.ts`). Un-flushed events are redelivered after a
 * crash, and redelivery is safe because the batch they belonged to was
 * never written.
 *
 * The alternative — having the handler await its own batch's flush —
 * deadlocks. The consumer delivers serially per stream, so a handler that
 * waits for a batch to fill waits for a message that cannot arrive until
 * it returns. Every batch would be one event.
 *
 * ## Flush on size OR age
 *
 * Size alone starves a low-traffic project: a batch that needs 8MB on a
 * project sending 50 events a day is an object per fortnight, and the
 * watermark — hence the checkpoint — sits still for that long. Age alone
 * makes objects unboundedly large under load. Either bound firing is
 * enough to close a batch.
 */

/** One archived event, with the transport coordinates it arrived on. */
export interface ArchiveRecord {
  readonly projectId: string;
  readonly environment: string;
  /** `YYYY-MM-DD` of `occurred_at`. Decides which day prefix it lands in. */
  readonly date: string;
  readonly stream: string;
  readonly offset: string;
  /** The envelope, verbatim, as it arrived. NDJSON is written from this. */
  readonly line: string;
}

/** A closed batch, ready to put. */
export interface ArchiveBatch {
  readonly projectId: string;
  readonly environment: string;
  readonly date: string;
  readonly stream: string;
  readonly firstOffset: string;
  readonly lastOffset: string;
  readonly records: readonly ArchiveRecord[];
  readonly bytes: number;
  readonly openedAtMs: number;
}

export interface ArchiveBatcherLimits {
  /** Close a batch once its NDJSON body reaches this many bytes. */
  readonly maxBytes: number;
  /** Close a batch once it holds this many records. */
  readonly maxRecords: number;
  /** Close a batch this long after its first record, whatever its size. */
  readonly maxAgeMs: number;
}

interface OpenBatch {
  readonly projectId: string;
  readonly environment: string;
  readonly date: string;
  readonly stream: string;
  readonly records: ArchiveRecord[];
  bytes: number;
  readonly openedAtMs: number;
  minOffset: bigint;
  maxOffset: bigint;
}

// A NUL, written as an escape so the file stays greppable — ripgrep skips
// files containing a raw NUL byte. Chosen over a slash or a space because
// a project id or stream name may contain either, and a separator that
// can appear inside a component makes two different keys collide.
const KEY_SEPARATOR = "\u0000";

function batchKey(record: ArchiveRecord): string {
  return [record.projectId, record.environment, record.date, record.stream].join(KEY_SEPARATOR);
}

function toBigInt(offset: string): bigint {
  try {
    return BigInt(offset);
  } catch {
    // A non-numeric offset would poison every comparison the watermark
    // makes. Treating it as 0 keeps the watermark conservative — it can
    // only hold the checkpoint back, never advance it past real work.
    return 0n;
  }
}

/**
 * Accumulates records into batches and tracks what is durable.
 *
 * Not thread-safe and does not need to be: the consumer delivers serially
 * per stream, and the flush loop runs on the same event loop.
 */
export class ArchiveBatcher {
  readonly #limits: ArchiveBatcherLimits;
  readonly #open = new Map<string, OpenBatch>();
  /** Batches handed to a caller for putting, not yet confirmed durable. */
  readonly #inFlight = new Map<string, ArchiveBatch>();
  /** Highest offset seen per stream, durable or not. */
  readonly #highestSeen = new Map<string, bigint>();
  #inFlightSeq = 0;

  constructor(limits: ArchiveBatcherLimits) {
    this.#limits = limits;
  }

  /** Add one record to its batch, opening the batch if needed. */
  add(record: ArchiveRecord, nowMs: number): void {
    const key = batchKey(record);
    const offset = toBigInt(record.offset);
    const seen = this.#highestSeen.get(record.stream);
    if (seen === undefined || offset > seen) this.#highestSeen.set(record.stream, offset);

    const existing = this.#open.get(key);
    // +1 for the newline this record contributes to the NDJSON body.
    const size = Buffer.byteLength(record.line, "utf8") + 1;
    if (existing === undefined) {
      this.#open.set(key, {
        projectId: record.projectId,
        environment: record.environment,
        date: record.date,
        stream: record.stream,
        records: [record],
        bytes: size,
        openedAtMs: nowMs,
        minOffset: offset,
        maxOffset: offset,
      });
      return;
    }
    existing.records.push(record);
    existing.bytes += size;
    if (offset < existing.minOffset) existing.minOffset = offset;
    if (offset > existing.maxOffset) existing.maxOffset = offset;
  }

  /** How many records are buffered and not yet handed out. */
  bufferedRecords(): number {
    let total = 0;
    for (const batch of this.#open.values()) total += batch.records.length;
    return total;
  }

  /**
   * Close every batch that has hit a limit and hand them over.
   *
   * `force` closes everything regardless — used on shutdown, where the
   * alternative is discarding buffered events whose checkpoint the
   * watermark is (correctly) still holding back.
   */
  takeDue(nowMs: number, force = false): readonly ArchiveBatch[] {
    const taken: ArchiveBatch[] = [];
    for (const [key, open] of this.#open) {
      const due =
        force ||
        open.bytes >= this.#limits.maxBytes ||
        open.records.length >= this.#limits.maxRecords ||
        nowMs - open.openedAtMs >= this.#limits.maxAgeMs;
      if (!due) continue;
      this.#open.delete(key);
      const batch: ArchiveBatch = {
        projectId: open.projectId,
        environment: open.environment,
        date: open.date,
        stream: open.stream,
        firstOffset: open.minOffset.toString(),
        lastOffset: open.maxOffset.toString(),
        records: open.records,
        bytes: open.bytes,
        openedAtMs: open.openedAtMs,
      };
      this.#inFlightSeq += 1;
      this.#inFlight.set(`${key}${KEY_SEPARATOR}${String(this.#inFlightSeq)}`, batch);
      taken.push(batch);
    }
    return taken;
  }

  /**
   * Mark a taken batch durable. Call ONLY after the put returned.
   *
   * Calling this before the put is what the whole module exists to
   * prevent: the watermark would advance, the checkpoint would follow,
   * and a crash before the put would lose the batch with no trace.
   */
  settle(batch: ArchiveBatch): void {
    for (const [key, pending] of this.#inFlight) {
      if (pending === batch) {
        this.#inFlight.delete(key);
        return;
      }
    }
  }

  /**
   * Return a failed batch to the open set so the next flush retries it.
   *
   * Its records keep their original `openedAtMs`, so a batch that failed
   * is immediately due again rather than waiting out a fresh age window.
   */
  requeue(batch: ArchiveBatch): void {
    this.settle(batch);
    const key = [batch.projectId, batch.environment, batch.date, batch.stream].join(KEY_SEPARATOR);
    const existing = this.#open.get(key);
    if (existing === undefined) {
      this.#open.set(key, {
        projectId: batch.projectId,
        environment: batch.environment,
        date: batch.date,
        stream: batch.stream,
        records: [...batch.records],
        bytes: batch.bytes,
        openedAtMs: batch.openedAtMs,
        minOffset: toBigInt(batch.firstOffset),
        maxOffset: toBigInt(batch.lastOffset),
      });
      return;
    }
    // Records that arrived while the put was in flight belong to the same
    // batch. Prepending keeps the object's offset range contiguous.
    existing.records.unshift(...batch.records);
    existing.bytes += batch.bytes;
    const first = toBigInt(batch.firstOffset);
    if (first < existing.minOffset) existing.minOffset = first;
  }

  /**
   * The highest offset on `stream` whose events are all in object storage,
   * or `undefined` when nothing on it is durable yet.
   *
   * Defined as "one below the lowest offset still pending", because
   * durability is a property of a PREFIX of the stream, not of individual
   * offsets. A checkpoint at an offset asserts everything below it was
   * handled, so a single pending batch at offset 40 holds the watermark at
   * 39 even if offsets 41-200 are already written.
   */
  durableOffset(stream: string): string | undefined {
    let lowestPending: bigint | undefined;
    for (const open of this.#open.values()) {
      if (open.stream !== stream) continue;
      if (lowestPending === undefined || open.minOffset < lowestPending) {
        lowestPending = open.minOffset;
      }
    }
    for (const batch of this.#inFlight.values()) {
      if (batch.stream !== stream) continue;
      const first = toBigInt(batch.firstOffset);
      if (lowestPending === undefined || first < lowestPending) lowestPending = first;
    }

    if (lowestPending === undefined) {
      const seen = this.#highestSeen.get(stream);
      return seen === undefined ? undefined : seen.toString();
    }
    if (lowestPending === 0n) return undefined;
    return (lowestPending - 1n).toString();
  }

  /** NDJSON body for a batch: one envelope per line, trailing newline. */
  static render(batch: ArchiveBatch): string {
    return `${batch.records.map((record) => record.line).join("\n")}\n`;
  }
}
