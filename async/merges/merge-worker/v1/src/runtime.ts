/**
 * merge-worker v1 runtime.
 *
 * Consumes `profile.events`, acts on `identity.merged` v2, and keeps
 * `polaris.profile_merge_map` current so person-keyed ClickHouse reads
 * resolve a tombstoned profile to its survivor.
 *
 * Every other event on the family is ignored without ceremony —
 * `profile.events` also carries `profile.created` and `profile.updated`, and
 * a worker that treated an unrecognised event as an error would fail on
 * normal traffic.
 *
 * ## Idempotence
 *
 * Redelivery is expected: the transport redelivers on any throw, and a
 * replay of the family is a supported operation. The write is an upsert into
 * a `ReplacingMergeTree(_version)` keyed on
 * `(project_id, environment, loser_profile_id)`, and `_version` is derived
 * from the merge's own `occurred_at` — so processing the same event twice
 * produces byte-identical rows that collapse rather than accumulate. There
 * is no dedupe store here because the storage engine already is one.
 *
 * ## Reading before writing
 *
 * A merge whose loser is already a winner elsewhere requires rewriting those
 * rows (see `merge-map.ts`). That needs a read, and the read is scoped to
 * exactly the rows pointing at the incoming loser rather than the whole map.
 * On a merge of two never-merged profiles — the overwhelming majority — it
 * returns nothing and costs one indexed lookup.
 */

import type { MergeMapStore } from "@polaris/shared-clickhouse";
import type { Logger } from "@polaris/shared-logger";
import type { ProcessorMetrics } from "@polaris/shared-processor";
import { classifyError } from "@polaris/shared-processor";
import { decodeEvent, type TransportMessagePayload } from "@polaris/shared-transport";

import { buildMergeRows, isActionableMerge, type MergeEvent } from "./merge-map.js";

/**
 * The ClickHouse surface this worker needs.
 *
 * Defined in `@polaris/shared-clickhouse` rather than here: raw SQL is
 * confined to that package by `scripts/lint-clickhouse-imports`, so the
 * worker gets a purpose-built store the same way the analytics sink and the
 * projection readers do. Re-exported so tests can name it without reaching
 * across packages.
 */
export type { MergeMapStore } from "@polaris/shared-clickhouse";

export interface MergeWorkerRuntimeInput {
  readonly store: MergeMapStore;
  readonly logger: Logger;
  readonly metrics: ProcessorMetrics;
  /** Identifies this worker on every metric series it writes. */
  readonly identity: { readonly processor_name: string; readonly processor_version: string };
}

const MERGE_EVENT = "identity.merged";

export function createMergeHandler(input: MergeWorkerRuntimeInput) {
  const base = input.identity;
  return async function handle(payload: TransportMessagePayload): Promise<void> {
    // `decodeEvent` THROWS on malformed JSON and returns null only for an
    // empty body — so the null check alone let a poison payload propagate
    // as an exception, which is not what the comment below promised.
    // Counted, not thrown: rethrowing would park a message no retry can
    // fix, and the transport's own DLQ path already owns poison handling.
    let decoded: unknown;
    try {
      decoded = decodeEvent(payload.message.value);
    } catch {
      input.metrics.incrementFailed({ ...base, reason: "decode_failed" });
      return;
    }
    if (decoded === null) {
      input.metrics.incrementFailed({ ...base, reason: "decode_failed" });
      return;
    }
    const envelope = decoded as Record<string, unknown>;
    input.metrics.incrementConsumed(base);

    if (envelope["event"] !== MERGE_EVENT) return;

    const event = toMergeEvent(envelope);
    if (event === null) {
      // Shape the schema should have guaranteed. Counted rather than thrown
      // for the same reason as a decode failure: no retry produces a
      // different answer.
      input.metrics.incrementFailed({ ...base, reason: "malformed_merge" });
      input.logger.warn(
        { component: "merge-worker", event_id: envelope["event_id"] },
        "identity.merged is missing fields the map needs — skipping",
      );
      return;
    }
    if (!isActionableMerge(event)) return;

    try {
      const chained = await input.store.chainedInto({
        projectId: event.project_id,
        environment: event.environment,
        profileId: event.loser_profile_id,
      });
      const rows = buildMergeRows(event, chained);
      await input.store.upsert(rows);

      input.metrics.incrementEmitted({
        ...base,
        project_id: event.project_id,
        environment: event.environment,
      });
      input.logger.info(
        {
          component: "merge-worker",
          project_id: event.project_id,
          environment: event.environment,
          merge_id: event.merge_id,
          loser_profile_id: event.loser_profile_id,
          winner_profile_id: event.winner_profile_id,
          // The number worth watching: a rewrite count that climbs means
          // chains are getting long, which is a resolver signal, not a
          // worker one.
          rewritten: rows.length - 1,
        },
        "profile merge map updated",
      );
    } catch (err) {
      input.metrics.incrementFailed({
        ...base,
        project_id: event.project_id,
        environment: event.environment,
        reason: String(classifyError(err)),
      });
      // Rethrown: a ClickHouse write that failed is worth retrying, and the
      // upsert is idempotent so the retry is free of consequence.
      throw err;
    }
  };
}

/** Narrow an envelope to the merge fields, or `null` if any are missing. */
function toMergeEvent(envelope: Record<string, unknown>): MergeEvent | null {
  const props = envelope["properties"];
  if (props === null || typeof props !== "object") return null;
  const p = props as Record<string, unknown>;

  const projectId = envelope["project_id"];
  const environment = envelope["environment"];
  const occurredAt = envelope["occurred_at"];
  const winner = p["winner_profile_id"];
  const loser = p["loser_profile_id"];
  const mergeId = p["merge_id"];
  const reason = p["reason"];

  if (
    typeof projectId !== "string" ||
    typeof environment !== "string" ||
    typeof occurredAt !== "string" ||
    typeof winner !== "string" ||
    typeof loser !== "string" ||
    typeof mergeId !== "string"
  ) {
    return null;
  }
  return {
    project_id: projectId,
    environment,
    occurred_at: occurredAt,
    winner_profile_id: winner,
    loser_profile_id: loser,
    merge_id: mergeId,
    reason: typeof reason === "string" ? reason : "",
  };
}
