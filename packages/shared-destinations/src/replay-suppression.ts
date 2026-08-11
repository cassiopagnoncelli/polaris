/**
 * Replay suppression for destination sends.
 *
 * Per `docs/architecture/06-destinations.md` "Delivery Model" and
 * `docs/architecture/05-processors-and-replay.md` "Replay Control Plane":
 *
 *   - Destination sends during replay are disabled by default.
 *   - External destination delivery during replay requires explicit opt-in.
 *
 * Polaris ships replay opt-in at TWO layers, both required for replay
 * traffic to advance past the suppression gate (P7-004):
 *
 *   1. **Host-level**.  The runtime's `allowReplay` constructor flag.
 *      Default `false`. The host wires `true` when the operator launches
 *      a replay tooling process; it covers the case where a host is
 *      dedicated to replay traffic.
 *
 *   2. **Per-instance**.  The `destinations.replay_opt_in` column on the
 *      destination row. Default `false` (the migration ships the column
 *      with a `false` default so every existing destination becomes
 *      opt-out at the moment P7-004 lands). Operators flip the column
 *      via `polaris destinations enable-replay <id> --reason <text>`,
 *      which writes an audit row in the same transaction.
 *
 * The gate is an AND of both signals: a host that has globally opted into
 * replay still cannot deliver to a destination whose row has
 * `replay_opt_in = false`. This is the central P7-004 guardrail — an
 * operator wanting to replay into Meta CAPI must NOT accidentally
 * trigger delivery to a co-resident GA4 destination.
 *
 * When suppression is in effect the runtime:
 *
 *   - DOES NOT write a `delivery_records` row. The suppression happens
 *     before the runtime resolves the instance's identity into a record
 *     shape; the metric counter + structured log line ARE the audit
 *     trail. (Operators see suppression rate in the metric and the full
 *     opt-in history in `audit_records` for the destination.)
 *   - Increments
 *     `polaris_destination_replay_suppressed_total{vendor, environment,
 *     destination_id}` so an alert can fire on unexpected replay
 *     volume against opted-out destinations.
 *   - Emits a structured INFO log line with the destination id, replay
 *     job id (when present), and the suppression reason.
 *   - Returns without invoking the mapper or deliverer.
 *
 * The mechanism is per-message rather than per-instance because replay
 * traffic mixes in with live traffic on the same topic. The replay
 * tooling stamps a `polaris-replay: true` header (or a stronger
 * `polaris-replay-job-id` header for traceability); the runtime checks
 * both.
 *
 * @see docs/implementation/tasks/P7-004-destination-replay-guardrails.md
 */


/**
 * Header name the replay tooling stamps when redelivering an event for
 * replay purposes. Matches the platform header convention from
 * `@polaris/shared-transport/src/headers.ts`.
 */
import type { MessageHeaders } from "@polaris/shared-transport";

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
export function readReplayContext(headers: MessageHeaders | undefined): ReplayContext {
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
 * Suppression reason emitted by {@link applyReplayPolicy}. The reason is
 * surfaced through the metric label and the structured log line so an
 * operator triaging unexpected suppression sees exactly which gate
 * fired.
 *
 *   - `replay_disabled_host`     — host-level `allowReplay` is `false`.
 *                                  The runtime's owner did not wire the
 *                                  global override; replay traffic is
 *                                  refused regardless of the per-instance
 *                                  column.
 *   - `replay_disabled_instance` — the destination's
 *                                  `destinations.replay_opt_in` column is
 *                                  `false`. The host opted in globally
 *                                  but THIS destination has not been
 *                                  enabled. This is the common P7-004
 *                                  gate: a replay tooling host opts into
 *                                  replay for the vendor it targets, and
 *                                  the per-instance opt-in keeps other
 *                                  destinations safe.
 */
export type ReplaySuppressionReason = "replay_disabled_host" | "replay_disabled_instance";

/**
 * Policy decision for whether a replay message should be delivered or
 * suppressed.
 *
 * Inputs:
 *   - `context`         replay flags extracted from message headers
 *   - `allowHost`       host-level opt-in (the runtime's `allowReplay`
 *                       constructor flag). Default `false`.
 *   - `allowInstance`   per-instance opt-in (the destination's
 *                       `replay_opt_in` column). Default `false`.
 *
 * Decision:
 *   - non-replay message               -> `{ kind: 'deliver' }`
 *   - replay msg + !allowHost          -> suppress with reason
 *                                          `replay_disabled_host`
 *   - replay msg + allowHost +
 *     !allowInstance                   -> suppress with reason
 *                                          `replay_disabled_instance`
 *   - replay msg + allowHost +
 *     allowInstance                    -> deliver
 *
 * The host-level check fires FIRST because the host gate is the broader
 * one — when an operator forgot to wire `allowReplay` they want to see
 * the host-level reason in the alert, not the per-instance reason. When
 * both are configured but a specific destination is opted out, the
 * per-instance reason fires.
 */
export type ReplayPolicyDecision =
  | { readonly kind: "deliver" }
  | { readonly kind: "suppress"; readonly reason: ReplaySuppressionReason };

/**
 * Input accepted by {@link applyReplayPolicy}. The runtime calls this
 * between "consumed message" and "normalize"; a `suppress` decision
 * short-circuits the pipeline.
 *
 * Both `allowHost` and `allowInstance` must be `true` for a replay
 * message to advance past the gate. Either alone is insufficient —
 * P7-004's guardrail is the explicit AND.
 */
export interface ApplyReplayPolicyInput {
  /** Replay flags extracted from the consumed message's headers. */
  readonly context: ReplayContext;
  /**
   * Host-level opt-in (the runtime's `allowReplay` constructor flag).
   * Default `false` at the call site.
   */
  readonly allowHost: boolean;
  /**
   * Per-instance opt-in. The destination row's `replay_opt_in` column.
   * Default `false`: every newly-created destination is opt-out until an
   * operator flips it on.
   */
  readonly allowInstance: boolean;
}

/**
 * Apply replay suppression policy. The runtime calls this between
 * "consumed message" and "normalize"; a `suppress` decision short-circuits
 * the pipeline. See {@link ApplyReplayPolicyInput} for the input shape.
 */
export function applyReplayPolicy(input: ApplyReplayPolicyInput): ReplayPolicyDecision {
  if (!input.context.is_replay) return { kind: "deliver" };
  if (!input.allowHost) return { kind: "suppress", reason: "replay_disabled_host" };
  if (!input.allowInstance) return { kind: "suppress", reason: "replay_disabled_instance" };
  return { kind: "deliver" };
}

function readHeader(headers: MessageHeaders, name: string): string | undefined {
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
