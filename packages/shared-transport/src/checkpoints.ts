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
 * @see db/migrations/20260810000001_create_transport_checkpoints.sql
 */

import type { Database } from "@polaris/shared-db";
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
