/**
 * ClickHouse sink runtime.
 *
 * Consumes every canonical super stream and INSERTs batches into one of
 * two ingestion interface tables, which fan them into the materialized
 * views. This service exists because the RabbitMQ migration removed
 * ClickHouse's ability to consume for itself: the Kafka Engine table
 * pulled rows on its own, RabbitMQ streams have no ClickHouse engine,
 * and the AMQP engine that does exist has no offsets and therefore no
 * honest recovery story.
 *
 * ## Routing
 *
 * Polaris streams carry three kinds of fact, and they answer different
 * questions:
 *
 *   resolved.events         what a producer reported  -> analytics_events_queue
 *
 *   session.events       \
 *   identity.events       >  what Polaris concluded   -> analytics_processed_queue
 *   attribution.events   /
 *
 *   profile.events          what is now TRUE of a     -> BOTH: profile_events_queue
 *                           person                       for state, and the
 *                                                        processed queue for history
 *
 *   rejected.events         a violation record, not   -> violations_queue
 *                           an envelope
 *
 * This paragraph described an M3 dual-run until 2026-08-19: `resolved.events`
 * "joining the source side" alongside an `analytics.events` twin, with
 * `_version` deciding which of the two won the collapse. There is no twin.
 * `f9ae3d0` retired `analytics.events` and `enriched.events` outright —
 * the app is pre-production, so there was no traffic to protect and no
 * parity window to serve — and `resolved.events` has been the sole source
 * feed since.
 *
 * `_version` still matters, for the reason it always did: a replayed or
 * redelivered row must collapse against the original rather than beside
 * it. See `@polaris/shared-clickhouse/version.ts`.
 *
 * The split is made here, at INSERT time, rather than by a WHERE clause
 * in each materialized view. A filter would have to be right in three
 * places and fails silently when it is not — a derived event landing in
 * `analytics_raw` inflates every projection built on it, and nothing in
 * the system would say so. Choosing the table instead makes a routing
 * bug visible as rows in the wrong place.
 *
 * The two ANALYTICS tables have an identical column shape, so one `toQueueRow`
 * projection serves both paths; only the destination differs.
 *
 * Until this landed the sink read `analytics.events` alone, which meant
 * every geoip enrichment, session window, identity link and touchpoint
 * the processors computed expired with stream retention without ever
 * becoming queryable.
 *
 * ## Batching
 *
 * ClickHouse wants few large INSERTs. Each INSERT creates a part, and a
 * flood of small parts is the classic way to wedge a MergeTree table. So
 * the runtime accumulates rows and flushes when either bound trips:
 *
 *   - `batchMaxRows` rows are buffered, or
 *   - `batchMaxMs` has elapsed since the batch opened.
 *
 * ## Delivery guarantees
 *
 * At-least-once, and deliberately so:
 *
 *   1. rows accumulate in memory,
 *   2. the batch is INSERTed and ClickHouse acknowledges it,
 *   3. only then does the consumer's checkpoint become durable.
 *
 * A crash between (1) and (3) re-reads the batch from the stream and
 * re-inserts it. `analytics_raw`'s ReplacingMergeTree collapses the
 * duplicates on `(event_id, _version)` — which is exactly what it already
 * did for Kafka-engine redelivery, so the semantics downstream are
 * unchanged.
 *
 * Step (3) needs `DeferredCheckpointStore` to be true. The transport
 * advances a checkpoint as soon as the handler resolves, and this handler
 * resolves for rows that are still only buffered — so without deferral
 * the checkpoint would claim rows ClickHouse never received, and a crash
 * would drop up to `batchMaxRows` of them silently. Wrapping the store
 * holds those positions until the INSERT is acknowledged.
 *
 * The sink is the only consumer that needs this, because it is the only
 * one whose handler defers its side effect.
 *
 * One consequence worth knowing during an incident: the durable position
 * lags the last inserted row by exactly one message. The transport writes
 * a message's checkpoint *after* its handler returns, so the row that
 * triggered a flush is committed with the following batch. The lag errs
 * the safe way — a crash re-reads that row and ReplacingMergeTree
 * collapses the duplicate.
 *
 * The ingest log intentionally keeps duplicates: it records transport
 * truth, and "this batch was delivered twice" is a fact worth being able
 * to see.
 *
 * ## Ordering
 *
 * Per-partition ordering is preserved (the transport serializes handler
 * invocations per partition), but rows from different partitions
 * interleave inside a batch. That is fine: nothing downstream depends on
 * cross-partition order, and ReplacingMergeTree resolves per event key.
 */

import {
  ANALYTICS_PROCESSED_QUEUE_TABLE,
  ANALYTICS_QUEUE_TABLE,
  type AnalyticsQueueRow,
  type AnalyticsSinkWriter,
  buildClickHouseVersion,
  type ClickHouseVersionStage,
  PROFILE_EVENTS_QUEUE_TABLE,
  type ProfileEventQueueRow,
  VIOLATIONS_QUEUE_TABLE,
  type ViolationQueueRow,
} from "@polaris/shared-clickhouse";
import type { Logger } from "@polaris/shared-logger";
import { parseViolationRecord } from "@polaris/shared-schemas";
import {
  consumerFamiliesFor,
  type DeferredCheckpointStore,
  decodeEvent,
  type PolarisConsumer,
  redeliverQueueName,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_REJECTED_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  type TransportMessageHandler,
  type TransportMessagePayload,
} from "@polaris/shared-transport";

import { SINK_COMPONENT } from "./config.js";
import type { SinkMetrics } from "./metrics.js";

/**
 * Families carrying derived facts. Everything the sink reads that is not
 * a SOURCE-FACT family lands in `analytics_processed_queue`.
 */
const DERIVED_STREAM_FAMILIES = [
  STREAM_FAMILY_SESSION_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
] as const;

/**
 * Families carrying source facts — the event itself, not a fact derived
 * from it. They land in `analytics_events_queue` and therefore in
 * `analytics_raw`.
 *
 * ONE of them. This block described two during an M3 dual-run, with
 * `resolved.events` and a legacy `analytics.events` twin sharing an
 * `event_id` so they would collapse into each other and `_version`
 * deciding which survived. `f9ae3d0` retired the twin; the plural was
 * left behind.
 *
 * `resolved.events` is NOT a derived family despite arriving from a
 * processor: the row it produces IS the customer's event, enriched. A
 * derived family carries facts ABOUT events (`identity.linked`,
 * `session.started`), which is a different table and a different
 * question.
 */
// One source family now. `analytics.events` was the legacy projector's
// output and retired with it (126EPNIQ); `resolved.events` is the spine's.
// The TABLE is unchanged -- `analytics_events_queue` still receives source
// events, and conflating the retired FAMILY with that table would have
// taken the spine's own writes down with the fan-out.
const SOURCE_STREAM_FAMILIES = [STREAM_FAMILY_RESOLVED_EVENTS] as const;

/**
 * The profile plane. Its own queue, its own table, its own engine.
 *
 * Not a derived family despite arriving from the identity stage and the
 * traits runner: a derived event records something that HAPPENED, while
 * `profile.updated` records what is now TRUE of a person. Only one of those
 * is current state, and the difference is what makes `profiles` a
 * ReplacingMergeTree keyed per trait rather than another log.
 */
const PROFILE_STREAM_FAMILIES = [STREAM_FAMILY_PROFILE_EVENTS] as const;

/**
 * The schema-governance quarantine.
 *
 * The one family here that does NOT carry an envelope. Its messages are
 * violation records — the events they describe failed validation, which
 * is why they are on this family at all — so they cannot go through
 * `toQueueRow` and do not belong in any of the three envelope tables.
 */
const VIOLATION_STREAM_FAMILIES = [STREAM_FAMILY_REJECTED_EVENTS] as const;

/** True when a delivery came from the quarantine. */
function isViolationFamily(family: string): boolean {
  return VIOLATION_STREAM_FAMILIES.some(
    (known) => family === known || family.startsWith(`${known}.`),
  );
}

/** True when a delivery came from the profile plane. */
function isProfileEventFamily(family: string): boolean {
  return PROFILE_STREAM_FAMILIES.some(
    (known) => family === known || family.startsWith(`${known}.`),
  );
}

/**
 * True when a delivery came from a source-event family.
 *
 * The `.` prefix check covers per-project isolation: an isolated project
 * reads from `<family>.<project_id>`, which is still source events and
 * must still route to `analytics_events_queue`. Matching the bare family
 * alone would silently divert every isolated project's events into the
 * derived table.
 */
function isSourceEventFamily(family: string): boolean {
  return SOURCE_STREAM_FAMILIES.some(
    (source) => family === source || family.startsWith(`${source}.`),
  );
}

/**
 * Which producer's rank a delivery carries into `_version`.
 *
 * Read off the FAMILY rather than off the envelope, because the family
 * is transport truth the sink already holds: an envelope field would
 * have to be added to a `.strict()` contract every SDK shares, to carry
 * a value only ClickHouse reads.
 */
function versionStageFor(family: string): ClickHouseVersionStage {
  const resolved =
    family === STREAM_FAMILY_RESOLVED_EVENTS ||
    family.startsWith(`${STREAM_FAMILY_RESOLVED_EVENTS}.`);
  return resolved ? "resolved" : "legacy";
}

export interface ClickhouseSinkRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly writer: AnalyticsSinkWriter;
  readonly logger: Logger;
  readonly metrics: SinkMetrics;
  /** Flush when this many rows are buffered. */
  readonly batchMaxRows: number;
  /** Flush when the open batch is this old. */
  readonly batchMaxMs: number;
  /**
   * The consumer's checkpoint store, wrapped for deferral. The runtime
   * commits it after each acknowledged INSERT — see the module note on
   * delivery guarantees.
   */
  readonly checkpoints: DeferredCheckpointStore;
  /**
   * Projects currently isolated. Applied to every family the sink reads,
   * not just `analytics.events` — a project isolated for its source
   * events is isolated for its derived events too.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

export interface ClickhouseSinkRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed so tests can drive the handler without a broker. */
  readonly handler: TransportMessageHandler;
  /** Flush both open batches immediately. Used by shutdown and by tests. */
  flush(): Promise<void>;
  /** Rows currently buffered across both batches. Tests assert on this. */
  readonly pending: number;
}

export function createRuntime(deps: ClickhouseSinkRuntimeDeps): ClickhouseSinkRuntime {
  const now = deps.now ?? ((): number => Date.now());
  let sourceBatch: AnalyticsQueueRow[] = [];
  let processedBatch: AnalyticsQueueRow[] = [];
  let profileBatch: ProfileEventQueueRow[] = [];
  let violationBatch: ViolationQueueRow[] = [];
  let batchOpenedAt = now();

  /**
   * Is the batch due?
   *
   * EVERY buffer counts toward the row bound. Omitting one would let its
   * rows sit until the staleness timer regardless of volume — a plane
   * under load would flush on a clock rather than on a batch, and the row
   * bound would silently mean something different per table. This was a
   * real defect once, with three buffers and two counted; it is a function
   * now so a fifth destination cannot reintroduce it by editing one of two
   * copies of the sum.
   */
  function shouldFlush(): boolean {
    const rows =
      sourceBatch.length + processedBatch.length + profileBatch.length + violationBatch.length;
    return rows >= deps.batchMaxRows || now() - batchOpenedAt >= deps.batchMaxMs;
  }

  /**
   * Flush both batches, then commit once.
   *
   * The single commit is the part that matters. `DeferredCheckpointStore`
   * holds positions for every stream the sink reads, so committing after
   * the first INSERT would advance the derived families' checkpoints past
   * rows still sitting in the second buffer. One commit, after both
   * writes are acknowledged, keeps the durability contract that the
   * module note describes.
   *
   * If the second INSERT fails after the first succeeded, the rollback
   * re-reads both batches. The source rows are then inserted twice and
   * ReplacingMergeTree collapses them — the same at-least-once behaviour
   * a crash mid-batch already produces.
   */
  async function flush(): Promise<void> {
    if (
      sourceBatch.length === 0 &&
      processedBatch.length === 0 &&
      profileBatch.length === 0 &&
      violationBatch.length === 0
    ) {
      return;
    }
    const sourceRows = sourceBatch;
    const processedRows = processedBatch;
    const profileRows = profileBatch;
    const violationRows = violationBatch;
    // Swap the buffers before awaiting so a delivery that lands during the
    // INSERT accumulates into the next batch instead of being lost or
    // double-counted. The held checkpoints are taken in the same breath, so
    // the snapshot covers exactly these rows — a position written by another
    // partition mid-INSERT belongs to the next batch, not this one.
    sourceBatch = [];
    processedBatch = [];
    profileBatch = [];
    violationBatch = [];
    const held = deps.checkpoints.take();
    batchOpenedAt = now();
    const started = now();
    // Which INSERT is in flight, so a failure is attributable to a table.
    // An MV that throws fails the INSERT into ITS source table
    // (`materialized_views_ignore_errors` is 0), so this label is how a
    // materialized-view failure becomes visible -- there is no MV "state"
    // to poll for plain insert-triggered views.
    let inFlight: string = ANALYTICS_QUEUE_TABLE;
    try {
      if (sourceRows.length > 0) {
        inFlight = ANALYTICS_QUEUE_TABLE;
        await deps.writer.insertBatch(sourceRows, ANALYTICS_QUEUE_TABLE);
      }
      if (processedRows.length > 0) {
        inFlight = ANALYTICS_PROCESSED_QUEUE_TABLE;
        await deps.writer.insertBatch(processedRows, ANALYTICS_PROCESSED_QUEUE_TABLE);
      }
      // Third INSERT, same single-commit contract: the checkpoint advances
      // only after every write is acknowledged, so a failure here re-reads
      // all three batches rather than stranding the profile rows.
      if (profileRows.length > 0) {
        inFlight = PROFILE_EVENTS_QUEUE_TABLE;
        await deps.writer.insertProfileEvents(profileRows);
      }
      // Fourth INSERT, same single-commit contract.
      if (violationRows.length > 0) {
        inFlight = VIOLATIONS_QUEUE_TABLE;
        await deps.writer.insertViolations(violationRows);
      }
    } catch (err) {
      deps.metrics.recordInsertFailure(inFlight);
      // Put these positions back so the transport re-reads these rows
      // rather than resuming past them.
      deps.checkpoints.restore(held);
      throw err;
    }
    // The rows are durable in ClickHouse; the positions may follow.
    await deps.checkpoints.commit(held);
    const duration = now() - started;
    if (sourceRows.length > 0) {
      deps.metrics.recordBatch(sourceRows.length, duration, ANALYTICS_QUEUE_TABLE);
    }
    if (processedRows.length > 0) {
      deps.metrics.recordBatch(processedRows.length, duration, ANALYTICS_PROCESSED_QUEUE_TABLE);
    }
    if (profileRows.length > 0) {
      deps.metrics.recordBatch(profileRows.length, duration, PROFILE_EVENTS_QUEUE_TABLE);
    }
    if (violationRows.length > 0) {
      deps.metrics.recordBatch(violationRows.length, duration, VIOLATIONS_QUEUE_TABLE);
    }
    deps.logger.debug(
      {
        component: "clickhouse-sink.flush",
        rows: sourceRows.length,
        processed_rows: processedRows.length,
        profile_rows: profileRows.length,
        violation_rows: violationRows.length,
        duration_ms: duration,
      },
      "flushed batch to clickhouse",
    );
  }

  const handler: TransportMessageHandler = async (payload) => {
    // Checked FIRST, because a violation record is not an envelope and
    // `toQueueRow` would refuse it — silently, as a skip, which reads on
    // the dashboard as "the quarantine is empty".
    if (isViolationFamily(payload.family)) {
      const violation = toViolationRow(payload, deps.logger);
      if (violation === undefined) {
        deps.metrics.recordSkipped();
        return;
      }
      violationBatch.push(violation);
      deps.metrics.recordConsumed(
        violation.project_id,
        violation.environment,
        VIOLATIONS_QUEUE_TABLE,
      );
      // No lag metric: a violation's `received_at` is the ingester's
      // clock for an event that never entered the spine, so the number a
      // lag gauge would show is not the pipeline delay it is read as.
      if (shouldFlush()) await flush();
      return;
    }

    const row = toQueueRow(payload, deps.logger);
    if (row === undefined) {
      deps.metrics.recordSkipped();
      return;
    }
    // Three destinations now, so the branch is a lookup rather than a
    // nested ternary: a fourth family added to the wrong side of a `?:` is
    // invisible, while a missing case here is a table name that does not
    // exist.
    const table = isSourceEventFamily(payload.family)
      ? ANALYTICS_QUEUE_TABLE
      : isProfileEventFamily(payload.family)
        ? PROFILE_EVENTS_QUEUE_TABLE
        : ANALYTICS_PROCESSED_QUEUE_TABLE;
    if (table === ANALYTICS_QUEUE_TABLE) {
      sourceBatch.push(row);
    } else if (table === PROFILE_EVENTS_QUEUE_TABLE) {
      // BOTH tables, and this is the fix for a hole the whole profile plane
      // fell through until 2026-08-19.
      //
      // `profile_events_queue` is STATE: its one materialized view filters
      // `event = 'profile.updated'` and folds trait changes into
      // `polaris.profiles`. That filter is correct for what it feeds — but
      // it was the family's only reader, so every other event on the plane
      // reached ClickHouse and was silently discarded: `trait.computed`,
      // `audience.entered`, `audience.exited`, and every `journey.*`.
      //
      // Nothing failed. The INSERT succeeded, the sink counted the rows, and
      // the events evaporated inside a Null table — the same shape as the
      // `profile_id = ''` bug, one layer up.
      //
      // Two things the plan promised depended on this and could not work:
      // "traits history lives in ClickHouse (`profile.updated` events), not
      // Postgres" (§12), and the journey funnel queries in 07-clickhouse.md,
      // which read `analytics_processed` for events that never arrived.
      //
      // So the plane's events go to `analytics_processed` as HISTORY —
      // where every other derived fact already lives — and profile.updated
      // additionally rides the state path. One message, two rows, two
      // purposes, neither standing in for the other.
      const profileRow = toProfileQueueRow(row, deps.logger);
      if (profileRow !== undefined) profileBatch.push(profileRow);
      processedBatch.push(row);
    } else {
      processedBatch.push(row);
    }
    deps.metrics.recordConsumed(row.project_id, row.environment, table);
    deps.metrics.recordLag(row.ingested_at, now(), table);

    if (shouldFlush()) {
      // Awaiting here is what makes the checkpoint safe: the transport
      // advances the offset only after this handler resolves, so the rows
      // are durable in ClickHouse before the position moves past them.
      await flush();
    }
  };

  let started = false;
  let ticker: NodeJS.Timeout | undefined;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const isolated = deps.isolatedProjects ?? [];
    const families = [
      ...[
        ...SOURCE_STREAM_FAMILIES,
        ...DERIVED_STREAM_FAMILIES,
        ...PROFILE_STREAM_FAMILIES,
      ].flatMap((family) => [...consumerFamiliesFor(family, isolated)]),
      // The quarantine, added BARE rather than through
      // `consumerFamiliesFor` — which throws for a non-canonical family,
      // and `rejected.events` is deliberately non-canonical because it
      // supports no isolation. Subscribing to a routing branch is not
      // optional: rows that never arrive look identical to no violations
      // at all, which is also what a healthy platform looks like.
      ...VIOLATION_STREAM_FAMILIES,
    ];
    await deps.consumer.subscribe({
      families,
      queues: [redeliverQueueName(SINK_COMPONENT)],
    });
    deps.logger.info(
      { component: "clickhouse-sink.runtime", families, batch_max_rows: deps.batchMaxRows },
      "clickhouse sink subscribed to source, derived, profile and quarantine streams",
    );
    await deps.consumer.runEach(handler);

    // A low-traffic partition would otherwise hold rows until the next
    // message arrives, which could be minutes. The ticker bounds that.
    ticker = setInterval(
      () => {
        // Every buffer, not two of four. The ticker exists so a
        // low-traffic partition does not hold rows until the next message
        // arrives, and a quarantine is by nature low-traffic — checking
        // only the busy buffers would leave violations sitting longest in
        // exactly the deployments where they matter most.
        if (
          sourceBatch.length === 0 &&
          processedBatch.length === 0 &&
          profileBatch.length === 0 &&
          violationBatch.length === 0
        ) {
          return;
        }
        if (now() - batchOpenedAt < deps.batchMaxMs) return;
        void flush().catch((err: unknown) => {
          const error = err as Error;
          deps.logger.error(
            {
              component: "clickhouse-sink.flush",
              err: { name: error.name, message: error.message },
            },
            "timed batch flush failed; rows stay buffered for the next attempt",
          );
        });
      },
      Math.max(deps.batchMaxMs, 250),
    );
    ticker.unref?.();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    if (ticker !== undefined) clearInterval(ticker);
    // Stop consuming first, then flush what is buffered, so shutdown does
    // not race a delivery into a batch nobody will write.
    await deps.consumer.disconnect();
    await flush();
  }

  return {
    start,
    stop,
    handler,
    flush,
    get pending(): number {
      // All four. This counted two of three once, which made a full
      // profile buffer read as an idle sink on the readiness probe.
      return (
        sourceBatch.length + processedBatch.length + profileBatch.length + violationBatch.length
      );
    },
  };
}

/**
 * Project a delivered message onto an ingestion row.
 *
 * Returns `undefined` for a payload that cannot be a canonical envelope.
 * Skipping beats throwing: a malformed message would otherwise rewind the
 * partition and re-deliver forever, stalling ingestion for every healthy
 * event behind it.
 */
/**
 * The same envelope, reshaped for `profile_events_queue`.
 *
 * Derived from `toQueueRow`'s output rather than re-parsing the payload:
 * the decode, the required-field check and the `_version` derivation are
 * decisions that must not have two answers, and this needs the identical
 * ones. Only the COLUMNS differ.
 *
 * Returns undefined when the envelope names no profile. The MV drops such
 * rows anyway (`profile_id != ''`), so inserting them would be a write
 * whose only effect is to make the sink's row counter disagree with the
 * table — which is precisely how the previous bug hid: rows consumed,
 * batches inserted, nothing stored.
 */
/**
 * `profile.events` members that name no person, by design.
 *
 * `trait.computed` is a run summary about a DEFINITION -- it carries
 * `trait_key`, `run_id` and the changed/computed counts, and there is no
 * profile it could name. It rides this family because it is produced by
 * the same run, not because it is about somebody.
 *
 * Naming them matters because the skip below is otherwise a data-loss
 * warning. Every traits run emitted one warn per definition, and that
 * routine noise is what hid a REAL loss for as long as it did: the
 * identity stage's `profile.updated` was tripping the identical line, and
 * nobody reading a log full of expected warnings sees the unexpected one.
 */
const PROFILE_EVENTS_WITHOUT_A_PERSON: ReadonlySet<string> = new Set(["trait.computed"]);

export function toProfileQueueRow(
  row: AnalyticsQueueRow,
  logger: Logger,
): ProfileEventQueueRow | undefined {
  const source = safeParseObject(row.source);
  const profile = safeParseObject(row.profile);
  const profileId = str(profile?.["profile_id"]);

  if (profileId === undefined || profileId === "") {
    if (PROFILE_EVENTS_WITHOUT_A_PERSON.has(row.event)) {
      // Expected, and not a warning. See the set above.
      return undefined;
    }
    logger.warn(
      {
        component: "clickhouse-sink.decode",
        event_id: row.event_id,
        event: row.event,
        project_id: row.project_id,
      },
      "skipping profile.events payload whose envelope carries no profile.profile_id",
    );
    return undefined;
  }

  return {
    event_id: row.event_id,
    event: row.event,
    schema_version: row.schema_version,
    project_id: row.project_id,
    environment: row.environment,
    occurred_at: row.occurred_at,
    ingested_at: row.ingested_at,
    // Flat columns here, a JSON block in the analytics tables. This is the
    // whole reason the shapes cannot be shared.
    source_id: str(source?.["id"]) ?? "",
    source_type: str(source?.["type"]) ?? "",
    profile_id: profileId,
    properties: row.properties,
    _version: row._version,
  };
}

/** `JSON.parse` for a column this sink itself serialized; `{}` becomes undefined-safe. */
function safeParseObject(text: string): Record<string, unknown> | undefined {
  if (text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toQueueRow(
  payload: TransportMessagePayload,
  logger: Logger,
): AnalyticsQueueRow | undefined {
  const value = payload.message.value;
  if (value === null || value.length === 0) return undefined;

  let decoded: unknown;
  try {
    decoded = decodeEvent(value);
  } catch (err) {
    const error = err as Error;
    logger.warn(
      {
        component: "clickhouse-sink.decode",
        stream: payload.stream,
        offset: payload.message.offset,
        err: { name: error.name, message: error.message },
      },
      "skipping undecodable source payload",
    );
    return undefined;
  }

  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  const envelope = decoded as Record<string, unknown>;

  const eventId = str(envelope["event_id"]);
  const event = str(envelope["event"]);
  const projectId = str(envelope["project_id"]);
  const environment = str(envelope["environment"]);
  const occurredAt = str(envelope["occurred_at"]);
  const ingestedAt = str(envelope["ingested_at"]);
  if (
    eventId === undefined ||
    event === undefined ||
    projectId === undefined ||
    environment === undefined ||
    occurredAt === undefined ||
    ingestedAt === undefined
  ) {
    logger.warn(
      {
        component: "clickhouse-sink.decode",
        stream: payload.stream,
        offset: payload.message.offset,
      },
      "skipping source payload missing required envelope fields",
    );
    return undefined;
  }

  const processor = asRecord(envelope["processor"]);
  return {
    event_id: eventId,
    event,
    schema_version: num(envelope["schema_version"]) ?? 1,
    project_id: projectId,
    environment,
    // ClickHouse's best_effort DateTime parser accepts the canonical
    // ISO-8601 `...Z` shape the envelope carries.
    occurred_at: occurredAt,
    ingested_at: ingestedAt,
    source: json(envelope["source"]),
    identity: json(envelope["identity"]),
    context: json(envelope["context"]),
    consent: json(envelope["consent"]),
    privacy: json(envelope["privacy"]),
    properties: json(envelope["properties"]),
    processor_name: str(processor?.["name"]) ?? "",
    processor_version: str(processor?.["version"]) ?? "",
    // The whole block, not just the two columns the MV extracts: a later
    // reader wanting `traits` should not need a change here to get it.
    profile: json(envelope["profile"]),
    // Built from the producing stage and the envelope's own
    // `ingested_at`, so a resolved row outranks its legacy twin for the
    // same event and a replay re-derives the identical number. The MVs
    // keep their `_version = 0` fallback for writers that bypass this
    // sink; nothing this sink emits is 0 any more.
    _version: buildClickHouseVersion({
      stage: versionStageFor(payload.family),
      ingestedAt: ingestedAt,
    }),
    _topic: payload.stream,
    _partition: payload.partition,
    _offset: Number(payload.message.offset),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Nested envelope objects travel to ClickHouse as JSON strings, matching
 * the `String` columns on the ingestion interface table. An absent object
 * becomes `''` rather than `'null'` so downstream `JSONExtract` calls see
 * an empty value instead of a literal null.
 */
function json(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Project a quarantined rejection onto its ingestion row.
 *
 * Deliberately NOT `toQueueRow`. A violation record is not an envelope —
 * the event it describes failed validation, which is why it is on this
 * family — so it has no `occurred_at`, may have no `event_id`, and shares
 * no columns with the three envelope tables.
 *
 * `undefined` on anything unparseable, for the same reason `toQueueRow`
 * skips: throwing would rewind the partition and redeliver forever,
 * stalling the quarantine behind one bad record. The counter the skip
 * feeds is the signal.
 */
export function toViolationRow(
  payload: TransportMessagePayload,
  logger: Logger,
): ViolationQueueRow | undefined {
  const value = payload.message.value;
  if (value === null || value.length === 0) return undefined;

  let decoded: unknown;
  try {
    decoded = decodeEvent(value);
  } catch (err) {
    logger.warn(
      {
        component: "clickhouse-sink.violation",
        stream: payload.stream,
        offset: payload.message.offset,
        err: err as Error,
      },
      "rejected.events payload is not decodable JSON",
    );
    return undefined;
  }

  const record = parseViolationRecord(decoded);
  if (record === null) {
    logger.warn(
      {
        component: "clickhouse-sink.violation",
        stream: payload.stream,
        offset: payload.message.offset,
      },
      "rejected.events payload is not a violation record",
    );
    return undefined;
  }

  return {
    violation_id: record.violation_id,
    violation_version: record.violation_version,
    project_id: record.project_id,
    environment: record.environment,
    // ClickHouse has no nullable here by choice: an absent hint is the
    // empty string, which `LowCardinality(String)` stores for free and
    // every dashboard filter already handles. A Nullable column would add
    // a null map to a table whose whole point is cheap aggregation.
    event: record.event ?? "",
    event_id: record.event_id ?? "",
    schema_version: record.schema_version ?? 0,
    reason: record.reason,
    paths: [...record.paths],
    redacted_sample: record.redacted_sample,
    received_at: record.received_at,
  };
}
