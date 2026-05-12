/**
 * Pure transform: raw.events envelope -> analytics.events envelope.
 *
 * v1 behaviour is a passthrough projector. Every canonical envelope field
 * is copied verbatim from the input, then the emitted event is stamped with
 * processor metadata so downstream consumers (ClickHouse Kafka Engine, replay,
 * lineage queries) can identify which processor produced the record.
 *
 * Two stamp shapes are emitted side by side:
 *
 *   1. A nested `processor` object — matches the example in
 *      `docs/architecture/05-processors-and-replay.md` ("Processor
 *      Metadata") and is the canonical traceability slot for future
 *      processors and replay tooling.
 *
 *   2. Top-level `processor_name` and `processor_version` fields — match
 *      the columns ClickHouse reads through its Kafka Engine table
 *      (`sql/clickhouse/10_analytics_events_queue.sql`). The Kafka Engine
 *      uses JSONEachRow with `input_format_skip_unknown_fields = 1`, so
 *      both shapes coexist cleanly: ClickHouse picks up the flat columns
 *      and ignores the nested object.
 *
 * The stamping is delegated to `@polaris/shared-processor`'s
 * `stampProcessorMetadata` so the dual-shape envelope stays consistent
 * across every Polaris processor. The transform exported here remains a
 * pure function: no side effects, no I/O, no schema validation. Tests
 * (golden fixture + structural) and the replay executor (P7-003) can call
 * it without setup.
 *
 * Versioning rule: any change to this function's output shape requires a
 * new processor version directory (`processors/analytics-projector/v2/`)
 * with its own manifest. See `docs/architecture/05-processors-and-replay.md`
 * "Processor Versioning".
 */

import {
  type ProcessorIdentity,
  type ProcessorStamp as SharedProcessorStamp,
  stampProcessorMetadata,
} from "@polaris/shared-processor";

/**
 * Static processor identity for v1. Held as a frozen object so callers
 * cannot mutate it, and exported so the bootstrap layer can use the same
 * literal for log bindings, consumer group naming, and the manifest.
 *
 * The version label intentionally matches the directory name (`v1`) and
 * is a string, not an integer, per the architecture doc's stamp example
 * and the ClickHouse `processor_version` column type
 * (`LowCardinality(String)`).
 */
export const PROCESSOR_NAME = "analytics-projector" as const;
export const PROCESSOR_VERSION = "v1" as const;

/**
 * Frozen identity literal reused by the runtime helpers. Exporting the
 * narrowed-type version lets external callers (tests, replay) reference
 * the same `(name, version)` constant the runtime uses.
 */
export const PROCESSOR_IDENTITY: ProcessorIdentity = Object.freeze({
  name: PROCESSOR_NAME,
  version: PROCESSOR_VERSION,
});

/**
 * Identity layer the transform passes through unchanged. The shape is
 * declared structurally so the transform package does not need to import
 * `@polaris/shared-schemas` — that keeps the transform reusable from
 * test fixtures and replay tooling.
 */
export interface RawEventIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
  readonly device_id: string | null;
}

/**
 * Source layer the transform passes through unchanged. Mirrors the
 * canonical envelope's `source` shape.
 */
export interface RawEventSource {
  readonly type: string;
  readonly id: string;
  readonly sdk?: string | null | undefined;
  readonly sdk_version?: string | null | undefined;
}

/**
 * Input envelope shape: the canonical raw event with `project_id`,
 * `environment`, `ingested_at`, and trusted `source.id` already stamped
 * by the ingester (per `01-event-contract.md` "Trusted Metadata").
 *
 * `consent` and `privacy` are informational and may be absent.
 * `properties` is event-owner discretion and intentionally typed as a
 * record of unknowns — the transform does not look inside.
 */
export interface RawEventEnvelope {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: RawEventSource;
  readonly identity: RawEventIdentity;
  readonly context: Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Processor stamp: the structured `processor` object copied onto the
 * emitted envelope. `ran_at` is an ISO 8601 UTC timestamp recording when
 * this specific transform invocation produced the output — useful for
 * staleness inspection and replay lineage diff.
 *
 * Locked to the v1 `(name, version)` literals so the local type contract
 * stays narrower than the shared helper's `string` shape.
 */
export interface ProcessorStamp {
  readonly name: typeof PROCESSOR_NAME;
  readonly version: typeof PROCESSOR_VERSION;
  readonly ran_at: string;
  readonly run_id?: string | undefined;
}

/**
 * Output envelope shape: the input envelope copied verbatim, plus the
 * processor stamp in both nested and flat forms. The flat columns
 * (`processor_name`, `processor_version`) are what ClickHouse's
 * `analytics_events_queue` Kafka Engine table reads.
 */
export interface AnalyticsEventEnvelope {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: RawEventSource;
  readonly identity: RawEventIdentity;
  readonly context: Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;

  // Nested processor stamp — canonical traceability slot per architecture.
  readonly processor: ProcessorStamp;

  // Flat columns for ClickHouse Kafka Engine ingestion.
  readonly processor_name: typeof PROCESSOR_NAME;
  readonly processor_version: typeof PROCESSOR_VERSION;
}

/**
 * Options for `transformToAnalyticsEvent`. The runtime supplies `now` so
 * tests can pin `ran_at` deterministically; production uses the default.
 * `run_id` is forwarded through to the nested processor stamp when the
 * runtime has registered a run (production); golden-fixture tests omit it.
 */
export interface TransformOptions {
  readonly now?: () => Date;
  readonly run_id?: string | undefined;
}

/**
 * Produce an `analytics.events` envelope from a `raw.events` envelope.
 *
 * Delegates to `@polaris/shared-processor`'s `stampProcessorMetadata`
 * helper so the dual-shape envelope (nested `processor` + flat columns)
 * stays consistent with every other Polaris processor. The helper:
 *
 *   - reads each envelope field explicitly (no spread) so the analytics
 *     envelope stays a known, audited shape,
 *   - omits `consent` / `privacy` from the output when the input did not
 *     carry them (avoids ClickHouse `JSONEachRow` flagging
 *     `"undefined"` strings),
 *   - returns a value typed as `StampedEnvelope<RawEventEnvelope>`. The
 *     cast below narrows the helper's general `string` typing for
 *     `processor.name` / `processor.version` back to the v1-pinned
 *     literals declared on `ProcessorStamp` and `AnalyticsEventEnvelope`.
 */
export function transformToAnalyticsEvent(
  raw: RawEventEnvelope,
  options: TransformOptions = {},
): AnalyticsEventEnvelope {
  const stamped = stampProcessorMetadata(raw, {
    identity: PROCESSOR_IDENTITY,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.run_id !== undefined ? { run_id: options.run_id } : {}),
  });

  // The helper returns the dual shape with `string`-typed processor name
  // and version. Locally we re-declare those as the v1 literals so the
  // analytics envelope's TS contract stays as strict as before this
  // refactor. The runtime values are identical.
  const narrowed: AnalyticsEventEnvelope = stamped as unknown as AnalyticsEventEnvelope;
  // Belt-and-suspenders: assert the value matches the local pin. This
  // executes once per call but is O(1).
  const procStamp = narrowed.processor as SharedProcessorStamp;
  if (procStamp.name !== PROCESSOR_NAME || procStamp.version !== PROCESSOR_VERSION) {
    throw new Error(
      `analytics-projector v1 produced unexpected processor stamp: ${JSON.stringify(procStamp)}`,
    );
  }
  return narrowed;
}
