/**
 * archiver v1 runtime.
 *
 * Consumes `raw.events` and buffers each envelope into the batch for its
 * `(project, environment, occurred_at date, stream)`. A background loop
 * flushes batches that have hit a size or age bound. Nothing else happens
 * here — the interesting arithmetic is the durability watermark in
 * `@polaris/shared-archive`, and the interesting decision is which
 * timestamp the day prefix comes from.
 *
 * ## The handler does not wait for the flush
 *
 * It cannot. The consumer delivers serially per stream, so a handler that
 * waited for its own batch to be written would be waiting for a message
 * that cannot arrive until it returns — every batch would hold one event.
 * Instead the handler returns immediately and the CHECKPOINT is held back
 * to the last durably-archived offset (`createDeferredCheckpointStore`).
 * Un-flushed events are redelivered after a crash.
 *
 * ## Verbatim bytes, not a re-serialisation
 *
 * The archived line is the payload as it arrived, not `JSON.stringify` of
 * a parsed envelope. Replay wants the bytes the producer wrote: key order,
 * number formatting and unicode escaping all survive a round trip through
 * the archive only if nothing re-encodes them. The envelope is parsed to
 * READ `project_id`, `environment` and `occurred_at`, and the original
 * text is what gets written.
 *
 * ## An event with no usable date is not silently dropped
 *
 * An envelope missing `occurred_at`, or carrying an unparseable one, has
 * no day prefix to land in. It is counted as failed and skipped rather
 * than filed under the archiver's wall clock: filing it under today would
 * make it invisible to a replay of the day it actually happened, which is
 * a loss that only shows up years later during an un-merge.
 */

import type { ArchiveBatcher } from "@polaris/shared-archive";
import { archiveDateOf } from "@polaris/shared-archive";
import type { Logger } from "@polaris/shared-logger";
import type { ProcessorMetrics } from "@polaris/shared-processor";
import { decodeEvent, type TransportMessagePayload } from "@polaris/shared-transport";

export interface ArchiverRuntimeInput {
  readonly batcher: ArchiveBatcher;
  readonly logger: Logger;
  readonly metrics: ProcessorMetrics;
  readonly identity: { readonly processor_name: string; readonly processor_version: string };
  readonly now: () => number;
}

export function createArchiveHandler(input: ArchiverRuntimeInput) {
  const base = input.identity;

  return async function handle(payload: TransportMessagePayload): Promise<void> {
    const raw = payload.message.value;
    if (raw === null) {
      input.metrics.incrementFailed({ ...base, reason: "empty_payload" });
      return;
    }

    // `decodeEvent` THROWS on malformed JSON and returns null only for an
    // empty body. Counted and skipped rather than rethrown: a throw
    // rewinds the reader and redelivers until the poison path parks the
    // message, and a stalled partition on the archiver is the one failure
    // that cannot be repaired later — the stream's retention window closes
    // over everything behind the stuck offset.
    let decoded: unknown;
    try {
      decoded = decodeEvent(raw);
    } catch {
      input.metrics.incrementFailed({ ...base, reason: "decode_failed" });
      input.logger.warn(
        { component: "archiver", stream: payload.stream, offset: payload.message.offset },
        "raw.events payload is not decodable JSON — cannot be filed",
      );
      return;
    }
    if (decoded === null) {
      input.metrics.incrementFailed({ ...base, reason: "empty_payload" });
      return;
    }
    input.metrics.incrementConsumed(base);

    const envelope = decoded as Record<string, unknown>;
    const projectId = envelope["project_id"];
    const environment = envelope["environment"];
    const occurredAt = envelope["occurred_at"];
    if (
      typeof projectId !== "string" ||
      typeof environment !== "string" ||
      typeof occurredAt !== "string"
    ) {
      input.metrics.incrementFailed({ ...base, reason: "missing_scope" });
      input.logger.warn(
        { component: "archiver", event_id: envelope["event_id"] },
        "envelope is missing project_id, environment or occurred_at — cannot be filed",
      );
      return;
    }

    const date = archiveDateOf(occurredAt);
    if (date === null) {
      input.metrics.incrementFailed({
        ...base,
        project_id: projectId,
        environment,
        reason: "unparseable_occurred_at",
      });
      input.logger.warn(
        { component: "archiver", event_id: envelope["event_id"], occurred_at: occurredAt },
        "occurred_at is unparseable — filing it under today would hide it from a replay of the day it happened",
      );
      return;
    }

    input.batcher.add(
      {
        projectId,
        environment,
        date,
        stream: payload.stream,
        offset: payload.message.offset,
        // Verbatim. See the module header.
        line: raw.toString("utf8"),
      },
      input.now(),
    );
  };
}

export interface FlushLoop {
  /** Stop the loop and write out whatever is still buffered. */
  stop(): Promise<void>;
}

export interface FlushLoopInput {
  readonly flush: (nowMs: number, force?: boolean) => Promise<unknown>;
  readonly intervalMs: number;
  readonly now: () => number;
  readonly onError: (err: unknown) => void;
}

/**
 * Drive flushes on a timer.
 *
 * The timer is what makes the AGE bound real: without it, a batch that
 * has aged out only closes when the next message on the same stream
 * arrives, which on a quiet project is exactly when it will not.
 *
 * `stop` forces a final flush. The alternative — exiting with a partial
 * batch in memory — is not a data loss (the checkpoint is still held
 * behind it, so the stream redelivers), but it turns every deploy into a
 * small replay, and on a busy shard that is a lot of duplicate work.
 */
export function startFlushLoop(input: FlushLoopInput): FlushLoop {
  let stopped = false;
  const timer = setInterval(() => {
    void (async () => {
      if (stopped) return;
      try {
        await input.flush(input.now());
      } catch (err) {
        input.onError(err);
      }
    })();
  }, input.intervalMs);
  // The loop must never be the reason the process stays alive.
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      try {
        await input.flush(input.now(), true);
      } catch (err) {
        input.onError(err);
      }
    },
  };
}
