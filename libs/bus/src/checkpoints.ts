/**
 * Consumer checkpoints.
 *
 * A Polaris stream consumer resumes at `checkpoint + 1`. The checkpoint is
 * the offset of the last **successfully handled** message — never the last
 * delivered one, because writing on delivery converts at-least-once into
 * at-most-once the moment a handler throws.
 *
 * Two implementations ship here:
 *
 *   - `PostgresCheckpointStore` — production. One row per
 *     `(group_name, stream)` in `transport_checkpoints`.
 *   - `InMemoryCheckpointStore` — tests and the replay reader, which
 *     deliberately keeps no durable position.
 *
 * The `CheckpointStore` interface is the seam: a consumer that writes its
 * own side effects to Postgres can implement it against its own
 * transaction and get checkpoint-with-side-effect atomicity, which the
 * Kafka setup could not offer.
 *
 * @see db/postgres/migrations/20260810000001_create_transport_checkpoints.sql
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";
import { parsePartitionStreamName } from "./streams.js";

/** A durable position for one (group, partition stream) pair. */
export interface Checkpoint {
  readonly group_name: string;
  readonly stream: string;
  readonly last_offset: string;
}

export interface CheckpointStore {
  /**
   * Read the stored offset for a stream, or `undefined` when the group has
   * never checkpointed it. `undefined` means "apply the consumer's
   * configured start position" (first / next), not "start at 0".
   */
  read(groupName: string, stream: string): Promise<string | undefined>;
  /** Read every stored offset for a group, keyed by stream. */
  readAll(groupName: string): Promise<ReadonlyMap<string, string>>;
  /** Durably record the last successfully handled offset. */
  write(checkpoint: Checkpoint): Promise<void>;
}

/**
 * PostgreSQL-backed checkpoint store.
 *
 * Writes are `INSERT ... ON CONFLICT DO UPDATE` with a `last_offset`
 * guard: a checkpoint only ever moves forward. The guard matters because a
 * consumer that briefly double-attaches (a slow shutdown overlapping a new
 * pod) would otherwise let the older reader rewind the newer one.
 */
export class PostgresCheckpointStore implements CheckpointStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async read(groupName: string, stream: string): Promise<string | undefined> {
    const row = await this.#db
      .selectFrom("transport_checkpoints")
      .select("last_offset")
      .where("group_name", "=", groupName)
      .where("stream", "=", stream)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return String(row.last_offset);
  }

  async readAll(groupName: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.#db
      .selectFrom("transport_checkpoints")
      .select(["stream", "last_offset"])
      .where("group_name", "=", groupName)
      .execute();
    return new Map(rows.map((row) => [row.stream, String(row.last_offset)]));
  }

  async write(checkpoint: Checkpoint): Promise<void> {
    const parsed = parsePartitionStreamName(checkpoint.stream);
    if (parsed === undefined) {
      throw new Error(
        `PostgresCheckpointStore: "${checkpoint.stream}" is not a partition stream name (<family>-<partition>)`,
      );
    }
    const offset = BigInt(checkpoint.last_offset);
    await this.#db
      .insertInto("transport_checkpoints")
      .values({
        group_name: checkpoint.group_name,
        stream: checkpoint.stream,
        family: parsed.family,
        partition: parsed.partition,
        last_offset: offset,
      })
      .onConflict((oc) =>
        oc
          .columns(["group_name", "stream"])
          .doUpdateSet((eb) => ({
            last_offset: eb.ref("excluded.last_offset"),
            updated_at: new Date(),
          }))
          // Monotonicity guard: a checkpoint only ever moves forward, so a
          // straggler reader that briefly overlaps a newer one (slow pod
          // shutdown) cannot rewind it.
          .where("transport_checkpoints.last_offset", "<", offset),
      )
      .execute();
  }
}

/**
 * A checkpoint store that holds writes until the owner says the work is
 * durable.
 *
 * The consumer advances a stream's checkpoint as soon as the handler
 * resolves — correct for a handler whose side effect completed inside the
 * call, wrong for one that *buffers*. The ClickHouse sink is the case
 * that forced this: it accumulates rows and INSERTs in batches, so its
 * handler resolves for rows that are still only in memory. Left alone,
 * the checkpoint claims those rows were handled and a crash discards
 * them — silent loss, on the one path with no upstream retry.
 *
 * Wrapping the real store defers every write until the owner says its batch
 * is durable.
 *
 * ## Why `take()` and not `commit()`
 *
 * The owner holds ONE store across every partition it reads — the sink runs
 * fifteen readers — and the transport writes each reader's position into it
 * independently. An earlier version drained the whole pending map inside
 * `commit()`, which silently broke the guarantee this class exists for:
 *
 *   flush() swaps its row buffers, awaits the INSERT, and DURING that await
 *   another partition's chain handles a message and writes its offset into
 *   the same map. The commit that follows persists that offset too — for a
 *   row that is still only in memory. A crash then loses the row under a
 *   checkpoint asserting it was handled. Exactly the failure the wrapper
 *   claims to prevent, reintroduced one partition over.
 *
 * So the snapshot is taken at the same instant the row buffers swap, and the
 * commit names what it is committing. Positions still only move forward:
 * `take()` keeps the highest offset per stream, and `restore()` merges back
 * without lowering anything a later batch already recorded.
 */
/** A snapshot of held positions, as returned by {@link DeferredCheckpointStore.take}. */
export type HeldCheckpoints = readonly Checkpoint[];

export class DeferredCheckpointStore implements CheckpointStore {
  readonly #inner: CheckpointStore;
  readonly #pending = new Map<string, Checkpoint>();

  constructor(inner: CheckpointStore) {
    this.#inner = inner;
  }

  /** Reads fall through: a resume must see the last DURABLE position. */
  async read(groupName: string, stream: string): Promise<string | undefined> {
    return this.#inner.read(groupName, stream);
  }

  async readAll(groupName: string): Promise<ReadonlyMap<string, string>> {
    return this.#inner.readAll(groupName);
  }

  /** Hold the position. Nothing reaches the durable store until `commit`. */
  async write(checkpoint: Checkpoint): Promise<void> {
    const entryKey = key(checkpoint.group_name, checkpoint.stream);
    const existing = this.#pending.get(entryKey);
    if (existing !== undefined && BigInt(existing.last_offset) >= BigInt(checkpoint.last_offset)) {
      return;
    }
    this.#pending.set(entryKey, checkpoint);
  }

  /**
   * Detach the positions held so far and start a fresh set.
   *
   * Call this at the same instant the owner swaps its row buffers: what is
   * returned covers exactly the rows being flushed, and anything a
   * concurrent reader writes afterwards accumulates for the next batch.
   */
  take(): HeldCheckpoints {
    const held = [...this.#pending.values()];
    this.#pending.clear();
    return held;
  }

  /** Durably persist a snapshot from {@link take}. */
  async commit(held: HeldCheckpoints): Promise<void> {
    for (const checkpoint of held) {
      await this.#inner.write(checkpoint);
    }
  }

  /**
   * Put a failed batch's positions back so the transport re-reads its rows.
   *
   * Merged rather than assigned: a later batch may already hold a higher
   * offset for the same stream, and restoring must never move a position
   * backwards.
   */
  restore(held: HeldCheckpoints): void {
    for (const checkpoint of held) {
      const entryKey = key(checkpoint.group_name, checkpoint.stream);
      const existing = this.#pending.get(entryKey);
      if (
        existing !== undefined &&
        BigInt(existing.last_offset) >= BigInt(checkpoint.last_offset)
      ) {
        continue;
      }
      this.#pending.set(entryKey, checkpoint);
    }
  }

  /** Test-only view of the currently held positions. */
  pendingSize(): number {
    return this.#pending.size;
  }

  /** Positions currently held but not yet durable. Tests assert on this. */
  get pending(): number {
    return this.#pending.size;
  }
}

/** Non-durable store. Tests, dry runs, and the replay reader. */
export class InMemoryCheckpointStore implements CheckpointStore {
  readonly #entries = new Map<string, string>();

  async read(groupName: string, stream: string): Promise<string | undefined> {
    return this.#entries.get(key(groupName, stream));
  }

  async readAll(groupName: string): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const prefix = `${groupName}::`;
    for (const [entryKey, value] of this.#entries) {
      if (entryKey.startsWith(prefix)) {
        out.set(entryKey.slice(prefix.length), value);
      }
    }
    return out;
  }

  async write(checkpoint: Checkpoint): Promise<void> {
    const existing = this.#entries.get(key(checkpoint.group_name, checkpoint.stream));
    if (existing !== undefined && BigInt(existing) >= BigInt(checkpoint.last_offset)) return;
    this.#entries.set(key(checkpoint.group_name, checkpoint.stream), checkpoint.last_offset);
  }
}

function key(groupName: string, stream: string): string {
  return `${groupName}::${stream}`;
}
