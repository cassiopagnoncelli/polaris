/**
 * The archive as a replay source.
 *
 * Implements the executor's `ReplayExecutorSource` contract against
 * object storage instead of the stream. Same interface, same filtering
 * obligations, different substrate — which is the whole point: the
 * executor, the guardrails, the destination suppression and the lineage
 * headers are all unchanged, and a replay from ninety-one days ago works
 * exactly like one from yesterday.
 *
 * This is what closes the un-merge story. `polaris profiles rebuild`
 * truncates a project's profile plane and replays `raw.events` through
 * the resolver, and until now its depth was bounded by the stream's
 * retention: a customer of five years came out with a `first_seen_at` of
 * ninety days ago. The command printed that bound rather than hiding it.
 * With this source the bound moves to how far back the archive goes.
 *
 * ## How a chunk is read
 *
 *   1. Every UTC day the chunk touches (usually one, two at a boundary).
 *   2. For each day, the stream manifests under it — one GET each — to
 *      learn which objects hold events in the chunk's time range.
 *   3. Missing manifest? List the day prefix and read every object.
 *   4. Parse, project onto `ReplaySourceEvent`, filter to plan scope and
 *      chunk bounds.
 *
 * Step 4 duplicates what the stream source does, and deliberately so: the
 * executor documents that the ADAPTER honours chunk bounds and trusts
 * what it receives. An adapter that returned a day's worth of events for
 * an hour's chunk would republish twenty-three hours of traffic nobody
 * asked for.
 *
 * ## Ordering
 *
 * Objects are read in key order, which the layout's zero-padded offsets
 * make offset order, and lines within an object are in the order they
 * were consumed. So a replay from the archive reproduces the original
 * per-partition order. Across partitions there is no order to reproduce —
 * there was none on the stream either.
 */

import {
  ARCHIVE_MANIFEST_NAME,
  archiveDatesInWindow,
  archiveDayPrefix,
  archiveEnvironmentPrefix,
  parseArchiveBatchKey,
} from "./layout.js";
import { manifestEntryIntersects, parseManifest } from "./manifest.js";
import type { ArchiveObjectStore } from "./object-store.js";

/**
 * The subset of `ReplaySourceEvent` this module produces.
 *
 * Structurally identical to `@polaris/shared-replay`'s type but declared
 * here so this package does not depend on that one — the dependency would
 * be backwards, and `shared-replay` is deliberately dependency-light.
 * The CLI wires the two together and the compiler checks the match there.
 */
export interface ArchivedReplayEvent {
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly partition_key: string;
  readonly value: Uint8Array;
  readonly headers: Record<string, string>;
}

export interface ArchiveReplaySourceOptions {
  readonly store: ArchiveObjectStore;
  /** Bucket prefix the archive is rooted at. */
  readonly prefix: string;
  /**
   * Called when a day's manifest is absent and the reader falls back to
   * listing. Wire a metric: a fallback on every chunk means manifests are
   * not being written, and the replay is doing far more GETs than it
   * should.
   */
  readonly onManifestMissing?: (input: {
    readonly projectId: string;
    readonly environment: string;
    readonly date: string;
  }) => void;
}

/** Plan fields the source filters on. */
export interface ArchiveReplayScope {
  readonly project_id: string;
  readonly environment: string;
  readonly event_name: string | null;
  readonly event_id: string | null;
}

export interface ArchiveReplayChunk {
  readonly from: string;
  readonly to: string;
}

export interface ArchiveReplaySource {
  fetchChunk(input: {
    readonly chunk: ArchiveReplayChunk;
    readonly plan: ArchiveReplayScope;
  }): Promise<readonly ArchivedReplayEvent[]>;
  /**
   * Which UTC days the archive holds for a project/environment.
   *
   * One delimiter listing, not a walk of every object. The planner uses
   * this to decide whether a window older than stream retention is
   * replayable at all.
   */
  coveredDates(input: {
    readonly projectId: string;
    readonly environment: string;
  }): Promise<readonly string[]>;
}

export function createArchiveReplaySource(
  options: ArchiveReplaySourceOptions,
): ArchiveReplaySource {
  const { store, prefix } = options;

  async function objectKeysFor(input: {
    projectId: string;
    environment: string;
    date: string;
    from: string;
    to: string;
  }): Promise<readonly string[]> {
    const dayPrefix = archiveDayPrefix({
      prefix,
      projectId: input.projectId,
      environment: input.environment,
      date: input.date,
    });

    const manifestKeys = await store.list(`${dayPrefix}_manifest/`);
    if (manifestKeys.length > 0) {
      const keys: string[] = [];
      for (const summary of manifestKeys) {
        const body = await store.get(summary.key);
        if (body === null) continue;
        for (const entry of parseManifest(body)) {
          if (manifestEntryIntersects(entry, input.from, input.to)) keys.push(entry.key);
        }
      }
      return keys.sort();
    }

    // No manifest for this day. List and read everything — an archive
    // written before manifests existed must still replay completely.
    options.onManifestMissing?.({
      projectId: input.projectId,
      environment: input.environment,
      date: input.date,
    });
    const listed = await store.list(dayPrefix);
    return listed
      .map((summary) => summary.key)
      .filter((key) => !key.includes(`/${ARCHIVE_MANIFEST_NAME}`) && !key.includes("/_manifest/"))
      .filter((key) => parseArchiveBatchKey(prefix, key) !== null)
      .sort();
  }

  return {
    async fetchChunk({ chunk, plan }) {
      const events: ArchivedReplayEvent[] = [];
      for (const date of archiveDatesInWindow(chunk.from, chunk.to)) {
        const keys = await objectKeysFor({
          projectId: plan.project_id,
          environment: plan.environment,
          date,
          from: chunk.from,
          to: chunk.to,
        });
        for (const key of keys) {
          const body = await store.get(key);
          if (body === null) continue;
          for (const line of body.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const event = toReplayEvent(trimmed);
            if (event === null) continue;
            if (!matchesScope(event, plan)) continue;
            if (!withinBounds(event, chunk)) continue;
            events.push(event);
          }
        }
      }
      return events;
    },

    async coveredDates({ projectId, environment }) {
      const base = archiveEnvironmentPrefix({ prefix, projectId, environment });
      const children = await store.listChildPrefixes(base);
      return children
        .map((child) => child.slice(base.length).replace(/\/$/, ""))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort();
    },
  };
}

/**
 * Project one archived line onto a replay event.
 *
 * `value` is the line re-encoded, not a stored copy of the original
 * bytes: the archive holds envelopes verbatim as JSON, so re-encoding
 * reproduces them. That is why the archive is NDJSON and not Parquet —
 * a columnar round trip through a schema would not give back the bytes
 * the producer serialised, and replay needs exactly those.
 */
function toReplayEvent(line: string): ArchivedReplayEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const envelope = parsed as Record<string, unknown>;

  const eventId = envelope["event_id"];
  const eventName = envelope["event"];
  const projectId = envelope["project_id"];
  const environment = envelope["environment"];
  const occurredAt = envelope["occurred_at"];
  if (
    typeof eventId !== "string" ||
    typeof eventName !== "string" ||
    typeof projectId !== "string" ||
    typeof environment !== "string" ||
    typeof occurredAt !== "string"
  ) {
    return null;
  }

  return {
    event_id: eventId,
    event_name: eventName,
    project_id: projectId,
    environment,
    occurred_at: occurredAt,
    // Same fallback the stream source uses. A republish without a key
    // lands on partition 0 and breaks ordering for everything there.
    partition_key:
      typeof envelope["partition_key"] === "string" ? envelope["partition_key"] : eventId,
    value: new TextEncoder().encode(line),
    headers: {},
  };
}

function matchesScope(event: ArchivedReplayEvent, plan: ArchiveReplayScope): boolean {
  if (event.project_id !== plan.project_id) return false;
  if (event.environment !== plan.environment) return false;
  if (plan.event_name !== null && event.event_name !== plan.event_name) return false;
  if (plan.event_id !== null && event.event_id !== plan.event_id) return false;
  return true;
}

function withinBounds(event: ArchivedReplayEvent, chunk: ArchiveReplayChunk): boolean {
  const at = Date.parse(event.occurred_at);
  const from = Date.parse(chunk.from);
  const to = Date.parse(chunk.to);
  if (!Number.isFinite(at) || !Number.isFinite(from) || !Number.isFinite(to)) return false;
  return at >= from && at <= to;
}
