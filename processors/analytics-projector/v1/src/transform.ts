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
 * The transform is exported as a pure function with no side effects so it
 * can be unit-tested with golden fixtures and reused by the replay
 * executor (P7-003) without instantiating the streaming runtime.
 *
 * Versioning rule: any change to this function's output shape requires a
 * new processor version directory (`processors/analytics-projector/v2/`)
 * with its own manifest. See `docs/architecture/05-processors-and-replay.md`
 * "Processor Versioning".
 */

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
 */
export interface ProcessorStamp {
  readonly name: typeof PROCESSOR_NAME;
  readonly version: typeof PROCESSOR_VERSION;
  readonly ran_at: string;
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
 */
export interface TransformOptions {
  readonly now?: () => Date;
}

/**
 * Produce an `analytics.events` envelope from a `raw.events` envelope.
 *
 * Implementation notes:
 *
 *   - Every envelope field is copied by reading the named property
 *     explicitly rather than spreading the input. The explicit copy
 *     guards against the transform silently propagating any *additional*
 *     fields a future raw event might carry — the analytics envelope
 *     stays a known, audited shape.
 *
 *   - `consent` and `privacy` are only included on the output when the
 *     input actually had them. Emitting `consent: undefined` would clutter
 *     ClickHouse's `consent` text column with the literal string
 *     `"undefined"` during JSON serialisation.
 *
 *   - The transform is intentionally synchronous and free of I/O so it can
 *     be invoked from streaming runtime, replay executor, and golden-fixture
 *     tests without setup.
 */
export function transformToAnalyticsEvent(
  raw: RawEventEnvelope,
  options: TransformOptions = {},
): AnalyticsEventEnvelope {
  const now = options.now ?? (() => new Date());
  const ranAt = now().toISOString();

  const processor: ProcessorStamp = {
    name: PROCESSOR_NAME,
    version: PROCESSOR_VERSION,
    ran_at: ranAt,
  };

  const base = {
    event_id: raw.event_id,
    event: raw.event,
    schema_version: raw.schema_version,
    project_id: raw.project_id,
    environment: raw.environment,
    occurred_at: raw.occurred_at,
    ingested_at: raw.ingested_at,
    source: raw.source,
    identity: raw.identity,
    context: raw.context,
    properties: raw.properties,
    processor,
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
  } as const;

  // exactOptionalPropertyTypes forbids re-emitting `consent: undefined`
  // when the input did not carry it. Branch so the output never has
  // those keys with undefined values.
  if (raw.consent !== undefined && raw.privacy !== undefined) {
    return { ...base, consent: raw.consent, privacy: raw.privacy };
  }
  if (raw.consent !== undefined) {
    return { ...base, consent: raw.consent };
  }
  if (raw.privacy !== undefined) {
    return { ...base, privacy: raw.privacy };
  }
  return base;
}
