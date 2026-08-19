/**
 * Processor identity helpers.
 *
 * Every Polaris processor is identified by an immutable `(name, version)` pair
 * — see `docs/architecture/05-processors-and-replay.md` "Processor Versioning".
 * The pair is what manifests, run rows, log lines, derived event metadata, and
 * replay targets reference. The helpers in this module produce the canonical
 * runtime shapes for that identity so every processor binds the same fields,
 * with the same names, in the same order.
 *
 * The package intentionally does NOT widen `processor_version` to a closed
 * union: the version directory tree (`{sync,async}/<stage>/<name>/v1/`,
 * `{sync,async}/<stage>/<name>/v2/`, ...) is the source of truth for what versions
 * exist. The manifest loader (see `./manifest.ts`) is the actual gate; here
 * the shape is structural so a processor's TypeScript literals (`"v1"`
 * `as const`) flow through unchanged.
 */
import type { StandardLogFields } from "@polaris/shared-logger";

/**
 * The fixed-shape identity of a versioned processor. Both fields are
 * platform-stamped onto every derived event (see `stampProcessorMetadata`)
 * and onto every log line emitted from the processor's runtime
 * (`processorLogContext`).
 *
 * `name` matches the directory name under `processors/` and the manifest's
 * `name` field; `version` matches the directory under `<name>/` and the
 * manifest's `version` field. Both are kept as broad `string` so concrete
 * processors can declare them with `as const` literals and the helpers stay
 * generic.
 */
export interface ProcessorIdentity {
  /** Processor catalog name (e.g. `analytics-projector`). */
  readonly name: string;
  /** Immutable version directory label (e.g. `v1`). */
  readonly version: string;
}

/**
 * Optional runtime context attached to a processor's log scope. The fields
 * are the small set every log line should be able to pivot on: which input
 * topic the processor is currently reading, which RabbitMQ partition, and
 * the per-run UUIDv7 once a run has been registered.
 *
 * `run_id` is intentionally optional — processors may emit log lines before
 * a run has been registered (e.g. during boot-time configuration checks),
 * and the helpers below tolerate that.
 */
export interface ProcessorLogContextInput {
  /** Processor `(name, version)` pair. */
  readonly identity: ProcessorIdentity;
  /** Per-run UUIDv7. Stamped once `registerRun` has assigned an id. */
  readonly run_id?: string | undefined;
  /** Input topic the processor is currently reading. */
  readonly topic?: string | undefined;
  /** RabbitMQ partition the processor is consuming. */
  readonly partition?: number | undefined;
}

/**
 * Build the standard log-binding object for a processor scope. The shape
 * matches the Pino child-logger bindings produced by
 * `@polaris/shared-logger`'s `withProcessor(...)`, plus an optional
 * `processor_run_id` slot.
 *
 * Returning a plain `StandardLogFields` (rather than a Pino-specific type)
 * keeps this module pure — services compose the result into their own
 * `logger.child(...)` call.
 *
 * The field names are the canonical ones from
 * `docs/architecture/08-observability-and-operations.md` "Standard Log
 * Fields":
 *
 *   - `processor_name`
 *   - `processor_version`
 *   - `processor_run_id` (optional)
 *   - `topic` (optional)
 *   - `partition` (optional)
 */
export function processorLogContext(
  input: ProcessorLogContextInput,
): StandardLogFields & { processor_run_id?: string } {
  const out: StandardLogFields & { processor_run_id?: string } = {
    processor_name: input.identity.name,
    processor_version: input.identity.version,
  };
  if (input.run_id !== undefined) out.processor_run_id = input.run_id;
  if (input.topic !== undefined) out.topic = input.topic;
  if (input.partition !== undefined) out.partition = input.partition;
  return out;
}
