/**
 * Replay suppression for destination sends.
 *
 * Per `docs/architecture/06-destinations.md` "Delivery Model" and
 * `docs/architecture/05-processors-and-replay.md` "Replay Control Plane":
 *
 *   - Destination sends during replay are disabled by default.
 *   - External destination delivery during replay requires explicit opt-in.
 *
 * The runtime reads the replay flag from the consumed message's headers
 * (the replay tooling stamps it onto every replayed envelope) and the
 * descriptor-level operator override. When suppression is in effect the
 * runtime:
 *
 *   - Writes a `delivery_records` row with status `dropped_invalid` and
 *     `error_class='policy'` so the audit trail shows the replay was
 *     observed but not delivered.
 *   - Increments
 *     `polaris_destination_replay_suppressed_total{vendor, environment}`.
 *   - Returns without invoking the mapper or deliverer.
 *
 * The mechanism is per-message rather than per-instance because replay
 * traffic mixes in with live traffic on the same topic. The replay
 * tooling stamps a `polaris-replay: true` header (or a stronger
 * `polaris-replay-job-id` header for traceability); the runtime checks
 * both.
 */

import type { IHeaders } from "kafkajs";

/**
 * Header name the replay tooling stamps when redelivering an event for
 * replay purposes. Matches the platform header convention from
 * `@polaris/shared-kafka/src/headers.ts`.
 */
export const POLARIS_HEADER_REPLAY = "polaris-replay";

/**
 * Header name the replay tooling stamps with the replay job id (UUIDv7).
 * Used by audit / metrics; not required for suppression to fire.
 */
export const POLARIS_HEADER_REPLAY_JOB_ID = "polaris-replay-job-id";

/** Replay flag extracted from message headers. */
export interface ReplayContext {
  /** True when the message carries a replay header. */
  readonly is_replay: boolean;
  /** Replay job id when present (UUIDv7). */
  readonly replay_job_id?: string;
}

/**
 * Inspect KafkaJS headers for replay markers. Returns `{ is_replay: false }`
 * when neither header is present.
 */
export function readReplayContext(headers: IHeaders | undefined): ReplayContext {
  if (headers === undefined) return { is_replay: false };
  const flag = readHeader(headers, POLARIS_HEADER_REPLAY);
  const jobId = readHeader(headers, POLARIS_HEADER_REPLAY_JOB_ID);
  if (jobId !== undefined && jobId.length > 0) {
    return { is_replay: true, replay_job_id: jobId };
  }
  if (flag === "true" || flag === "1") {
    return { is_replay: true };
  }
  return { is_replay: false };
}

/**
 * Policy decision for whether a replay message should be delivered or
 * suppressed.
 *
 * Inputs:
 *   - `context`     replay flags extracted from message headers
 *   - `allow`       per-descriptor opt-in. Default false (suppressed).
 *
 * Decision:
 *   - non-replay message       -> `{ kind: 'deliver' }`
 *   - replay message + allow=false -> `{ kind: 'suppress', reason: 'replay_disabled' }`
 *   - replay message + allow=true  -> `{ kind: 'deliver' }`
 */
export type ReplayPolicyDecision =
  | { readonly kind: "deliver" }
  | { readonly kind: "suppress"; readonly reason: "replay_disabled" };

/**
 * Apply replay suppression policy. The runtime calls this between
 * "consumed message" and "normalize"; a `suppress` decision short-circuits
 * the pipeline.
 */
export function applyReplayPolicy(context: ReplayContext, allow: boolean): ReplayPolicyDecision {
  if (!context.is_replay) return { kind: "deliver" };
  if (allow) return { kind: "deliver" };
  return { kind: "suppress", reason: "replay_disabled" };
}

function readHeader(headers: IHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (first === undefined) return undefined;
    if (typeof first === "string") return first;
    if (first instanceof Buffer) return first.toString("utf8");
  }
  return undefined;
}
