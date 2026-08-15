/**
 * Replay-execute adapters for the object-storage archive.
 *
 * The stream keeps ninety days. Past that the events live in the archive
 * (`@polaris/shared-archive`, written by `async/warehouse/archiver/v1`),
 * and this file makes them look like a source the executor already knows
 * how to drive. Nothing downstream changes: the same executor, the same
 * replay headers, the same destination guardrails, the same lineage.
 *
 * ## Three sources, chosen by the plan
 *
 * `plan.source_kind` says which substrate holds the window — `stream`,
 * `archive`, or `mixed`. The choice is the planner's because it is a fact
 * about the deployment's retention, not an operator preference, and
 * getting it wrong is silent: a stream read of an archived window returns
 * nothing and looks exactly like a window with no events.
 *
 * The `mixed` adapter dispatches PER CHUNK against the retention cutoff.
 * Chunks are a day wide by default, so a chunk is almost always wholly on
 * one side; a chunk straddling the boundary is read from BOTH and
 * deduplicated by `event_id`, because the seam is exactly where an
 * off-by-one would drop events an operator would never think to look for.
 */

import type { ArchivedReplayEvent, ArchiveReplaySource } from "@polaris/shared-archive";
import type {
  ReplayExecutorSource,
  ReplayFetchChunkInput,
  ReplaySourceEvent,
} from "@polaris/shared-replay";

export interface BuildArchiveReplaySourceOptions {
  readonly archive: ArchiveReplaySource;
}

/**
 * Read every chunk from the archive.
 *
 * The shared package already filters to plan scope and chunk bounds — the
 * executor documents that obligation as the adapter's, and the archive
 * source honours it — so this is a projection, not a second filter.
 */
export function buildArchiveReplaySource(
  options: BuildArchiveReplaySourceOptions,
): ReplayExecutorSource {
  return {
    async fetchChunk({ chunk, plan }: ReplayFetchChunkInput) {
      const events = await options.archive.fetchChunk({
        chunk: { from: chunk.from, to: chunk.to },
        plan: {
          project_id: plan.project_id,
          environment: plan.environment,
          event_name: plan.event_name,
          event_id: plan.event_id,
        },
      });
      return events.map(toReplaySourceEvent);
    },
  };
}

export interface BuildMixedReplaySourceOptions {
  readonly stream: ReplayExecutorSource;
  readonly archive: ReplayExecutorSource;
  /**
   * The instant the stream's retention begins. Chunks entirely before it
   * come from the archive, chunks entirely after it from the stream, and
   * a chunk containing it from both.
   */
  readonly retentionCutoff: Date;
}

export function buildMixedReplaySource(
  options: BuildMixedReplaySourceOptions,
): ReplayExecutorSource {
  const cutoffMs = options.retentionCutoff.getTime();

  return {
    async fetchChunk(input: ReplayFetchChunkInput) {
      const fromMs = Date.parse(input.chunk.from);
      const toMs = Date.parse(input.chunk.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        throw new Error(
          `replay chunk timestamp parse failed: from=${input.chunk.from} to=${input.chunk.to}`,
        );
      }

      if (toMs < cutoffMs) return options.archive.fetchChunk(input);
      if (fromMs >= cutoffMs) return options.stream.fetchChunk(input);

      // Straddles the boundary. Read both and dedupe: the stream's
      // retention edge moves continuously while a replay runs, so which
      // side "owns" an event within the straddling chunk is not a
      // question with a stable answer. Reading both and deduping is the
      // only version that cannot drop an event at the seam.
      const [archived, streamed] = await Promise.all([
        options.archive.fetchChunk(input),
        options.stream.fetchChunk(input),
      ]);
      return dedupeByEventId([...archived, ...streamed]);
    },
  };
}

/**
 * First occurrence of each `event_id` wins.
 *
 * Archived events are passed first, so the archived copy is the one kept.
 * That is deliberate: an event near the retention edge may still be on the
 * stream, but the archived copy is the one that will still exist when this
 * replay is re-run to diagnose the first one.
 */
function dedupeByEventId(events: readonly ReplaySourceEvent[]): readonly ReplaySourceEvent[] {
  const seen = new Set<string>();
  const out: ReplaySourceEvent[] = [];
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    out.push(event);
  }
  return out;
}

function toReplaySourceEvent(event: ArchivedReplayEvent): ReplaySourceEvent {
  return {
    event_id: event.event_id,
    event_name: event.event_name,
    project_id: event.project_id,
    environment: event.environment,
    occurred_at: event.occurred_at,
    partition_key: event.partition_key,
    value: event.value,
    headers: event.headers,
  };
}
