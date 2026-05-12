/**
 * Child-logger context helpers.
 *
 * Pino's `logger.child(bindings)` is the canonical way to attach contextual
 * fields to a log scope. The helpers below produce typed binding objects that
 * match the standard log fields from
 * `docs/architecture/08-observability-and-operations.md`. They exist so
 * service code attaches context with autocomplete and consistent field names,
 * rather than hand-rolling object literals at each call site.
 *
 * Usage pattern:
 *
 * ```ts
 * import { createLogger, withRequest, withProcessor } from "@polaris/shared-logger";
 *
 * const root = createLogger({ service: "ingester-api" });
 *
 * // Per-request context — attach `request_id`, project, environment.
 * app.addHook("onRequest", (req, _reply, done) => {
 *   req.log = root.child(
 *     withRequest({
 *       request_id: req.id,
 *       project_id: req.project_id,
 *       environment: req.environment,
 *       source_id: req.source_id,
 *     }),
 *   );
 *   done();
 * });
 *
 * // Processor context — attach name/version/run.
 * const procLog = root.child(
 *   withProcessor({
 *     processor_name: "sessionizer",
 *     processor_version: "v1",
 *     topic: "raw.events",
 *     partition: 3,
 *   }),
 * );
 * ```
 *
 * The helpers return plain objects so callers can spread them into custom
 * bindings without losing typing.
 */

import type { StandardLogFields } from "./types.js";

/**
 * Bindings for per-HTTP-request scope. `request_id` is required so every line
 * inside a request scope can be correlated end-to-end. Other identifiers are
 * stamped as the ingester resolves the API key.
 */
export interface RequestContext {
  /** Per-request trace ID, typically UUIDv7. */
  request_id: string;
  /** Logical project owner stamped from the API key. */
  project_id?: string;
  /** Deployment environment stamped from the API key. */
  environment?: string;
  /** Trusted source identifier resolved from the API key. */
  source_id?: string;
}

/**
 * Bindings for source-bound scopes (e.g. an SDK transport, a webhook
 * receiver, an inbound vendor adapter). Use this when no request scope
 * exists but every log line belongs to a known source.
 */
export interface SourceContext {
  /** Source identifier (e.g. `payments-api`, `web-checkout`). */
  source_id: string;
  /** Project owner of the source. */
  project_id?: string;
  /** Deployment environment for the source. */
  environment?: string;
}

/**
 * Bindings for a processor scope. Processors are versioned semantic units.
 * `processor_name` and `processor_version` together identify the immutable
 * deployment artefact; runs are surfaced as separate fields on log lines.
 */
export interface ProcessorContext {
  /** Processor name (e.g. `sessionizer`). */
  processor_name: string;
  /** Immutable version directory label (e.g. `v1`). */
  processor_version: string;
  /** Input topic the processor is currently reading. */
  topic?: string;
  /** Redpanda partition the processor is owning. */
  partition?: number;
  /** Processor run identifier (UUIDv7), when running inside a scheduled run. */
  processor_run_id?: string;
}

/**
 * Bindings for a destination-consumer scope. Same versioning semantics as
 * processors. Consumers additionally carry `destination_id` so log lines
 * pivot per destination instance rather than per vendor adapter.
 */
export interface ConsumerContext {
  /** Consumer name (e.g. `meta-capi`). */
  consumer_name: string;
  /** Immutable version directory label (e.g. `v1`). */
  consumer_version: string;
  /** Destination instance identifier (operational runtime state). */
  destination_id?: string;
  /** Input topic the consumer is currently reading. */
  topic?: string;
  /** Redpanda partition the consumer is owning. */
  partition?: number;
}

/**
 * Bindings for a replay job. Used by replay planners, executors, and the
 * CLI when running scoped reprocessing. Replay lineage is recorded on the
 * job record itself; logs need only the job ID for join-back.
 */
export interface ReplayContext {
  /** Replay job identifier (UUIDv7). */
  replay_job_id: string;
  /** Topic being replayed. */
  topic?: string;
  /** Partition currently being replayed. */
  partition?: number;
  /** Target processor name when the replay is processor-scoped. */
  processor_name?: string;
  /** Target processor version when the replay is processor-scoped. */
  processor_version?: string;
}

/**
 * Build child-logger bindings for an HTTP request scope.
 *
 * Field names match the canonical envelope (`project_id`, `environment`,
 * `source_id`) so log lines join naturally against events without renaming.
 */
export function withRequest(ctx: RequestContext): StandardLogFields {
  const out: StandardLogFields = { request_id: ctx.request_id };
  if (ctx.project_id !== undefined) out.project_id = ctx.project_id;
  if (ctx.environment !== undefined) out.environment = ctx.environment;
  if (ctx.source_id !== undefined) out.source_id = ctx.source_id;
  return out;
}

/**
 * Build child-logger bindings for a source-bound scope.
 */
export function withSource(ctx: SourceContext): StandardLogFields {
  const out: StandardLogFields = { source_id: ctx.source_id };
  if (ctx.project_id !== undefined) out.project_id = ctx.project_id;
  if (ctx.environment !== undefined) out.environment = ctx.environment;
  return out;
}

/**
 * Build child-logger bindings for a processor scope.
 *
 * The returned object additionally carries `processor_run_id` (typed as
 * `StandardLogFields` would not, since runs are not part of the platform-wide
 * standard field list — they appear under processor-specific records).
 */
export function withProcessor(
  ctx: ProcessorContext,
): StandardLogFields & { processor_run_id?: string } {
  const out: StandardLogFields & { processor_run_id?: string } = {
    processor_name: ctx.processor_name,
    processor_version: ctx.processor_version,
  };
  if (ctx.topic !== undefined) out.topic = ctx.topic;
  if (ctx.partition !== undefined) out.partition = ctx.partition;
  if (ctx.processor_run_id !== undefined) out.processor_run_id = ctx.processor_run_id;
  return out;
}

/**
 * Build child-logger bindings for a destination-consumer scope.
 */
export function withConsumer(ctx: ConsumerContext): StandardLogFields {
  const out: StandardLogFields = {
    consumer_name: ctx.consumer_name,
    consumer_version: ctx.consumer_version,
  };
  if (ctx.destination_id !== undefined) out.destination_id = ctx.destination_id;
  if (ctx.topic !== undefined) out.topic = ctx.topic;
  if (ctx.partition !== undefined) out.partition = ctx.partition;
  return out;
}

/**
 * Build child-logger bindings for a replay scope.
 */
export function withReplay(ctx: ReplayContext): StandardLogFields {
  const out: StandardLogFields = { replay_job_id: ctx.replay_job_id };
  if (ctx.topic !== undefined) out.topic = ctx.topic;
  if (ctx.partition !== undefined) out.partition = ctx.partition;
  if (ctx.processor_name !== undefined) out.processor_name = ctx.processor_name;
  if (ctx.processor_version !== undefined) out.processor_version = ctx.processor_version;
  return out;
}

/**
 * Build child-logger bindings for a Redpanda topic + partition + offset
 * triple. Useful for retry / DLQ log lines where a single message is being
 * traced through a delivery attempt.
 */
export function withMessage(ctx: {
  topic: string;
  partition?: number;
  offset?: string | number;
  event_id?: string;
}): StandardLogFields {
  const out: StandardLogFields = { topic: ctx.topic };
  if (ctx.partition !== undefined) out.partition = ctx.partition;
  if (ctx.offset !== undefined) out.offset = ctx.offset;
  if (ctx.event_id !== undefined) out.event_id = ctx.event_id;
  return out;
}
