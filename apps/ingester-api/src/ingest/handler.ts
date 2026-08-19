import type { Logger } from "@polaris/shared-logger";
import {
  applyRedactions,
  emitAllRedactionMetrics,
  evaluate,
  type PatternRedactionMetricIncrement,
  POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  type PolicyDecision,
} from "@polaris/shared-policy";
import {
  BATCH_REASON_DUPLICATE,
  BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
  BATCH_REASON_IN_PROGRESS,
  BATCH_REASON_INVALID_REQUEST,
  BATCH_REASON_PUBLISH_FAILED,
  type BatchAcceptedResult,
  type BatchReasonCode,
  type BatchRejectedResult,
  type BatchResponse,
  type Envelope,
  type EventCatalog,
  isRetryableBatchReason,
  validateCatalogEvent,
} from "@polaris/shared-schemas";
import {
  buildRawEventsPartitionKey,
  type PolarisProducer,
  STREAM_FAMILY_RAW_EVENTS,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
} from "@polaris/shared-transport";
import type { IngestConfig } from "../config.js";
import { DEDUPE_LEASE_TTL_SEC, type DedupeStore } from "../dedupe/index.js";
import { eventLabel, type IngestMetrics } from "../metrics/registry.js";
import type { PolicyResolver } from "../policy/loader.js";
import type { IngestProjectConfigLookup } from "../project-config-lookup.js";
import type { QuarantineCandidate, QuarantinePublisher } from "./quarantine.js";
import { batchRequestSchema, type IngestRequestContext } from "./types.js";

/**
 * Per-request dependencies passed to the handler.
 *
 * The handler is constructed with one set of dependencies at startup
 * (`createIngestHandler`), then invoked per request. Construction-time
 * deps are read from the Fastify app context (catalog, policy resolver,
 * producer, dedupe, metrics, logger).
 */
export interface IngestHandlerDeps {
  readonly catalog: EventCatalog;
  readonly policy: PolicyResolver;
  readonly producer: PolarisProducer;
  readonly dedupe: DedupeStore;
  readonly metrics: IngestMetrics;
  readonly logger: Logger;
  /**
   * Sync isolation lookup. Defaults to the shared-only lookup until P11-008
   * wires the PostgreSQL-backed lookup; ingestion stays correct in the
   * meantime because the default returns "not isolated" for every project.
   */
  readonly isolation?: SyncIsolationLookup;
  readonly ingestConfig: IngestConfig;
  /**
   * Schema-governance quarantine. Optional: a deployment without one
   * rejects events exactly as before, it just cannot answer "which
   * projects are still sending `cvv`?". Absent in tests that are not
   * about the quarantine.
   */
  readonly quarantine?: QuarantinePublisher;
  /**
   * Per-project overrides, read from cache only. Synchronous by design — see
   * ../project-config-lookup.ts.
   */
  readonly projectConfig: IngestProjectConfigLookup;
  /**
   * UUIDv7 generator used to stamp envelope timestamps deterministically
   * during tests. Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
}

export interface IngestHandler {
  handle(
    payload: unknown,
    context: IngestRequestContext,
  ): Promise<{ readonly status: number; readonly body: BatchResponse | InvalidRequestBody }>;
}

/**
 * Response body returned when the entire batch envelope is malformed
 * (e.g. `events` is missing, not an array, or too large). Distinct from
 * per-event rejections — a malformed batch never reaches the per-event
 * loop, so the response shape is also distinct.
 */
export interface InvalidRequestBody {
  readonly accepted: readonly never[];
  readonly rejected: readonly never[];
  readonly error: { readonly code: typeof BATCH_REASON_INVALID_REQUEST; readonly message: string };
}

/**
 * Build the ingest handler. Holds the construction-time deps; returns an
 * object with a single `handle(payload, context)` method the route plumbs
 * Fastify's `request.body` / `request.auth` into.
 */
export function createIngestHandler(deps: IngestHandlerDeps): IngestHandler {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const now = deps.now ?? (() => new Date());

  async function handle(
    payload: unknown,
    context: IngestRequestContext,
  ): Promise<{ readonly status: number; readonly body: BatchResponse | InvalidRequestBody }> {
    // ---- top-level batch shape -----------------------------------------
    const parsed = batchRequestSchema.safeParse(payload);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      return {
        status: 400,
        body: {
          accepted: [],
          rejected: [],
          error: {
            code: BATCH_REASON_INVALID_REQUEST,
            message: firstIssue?.message ?? "request body is not a valid event batch",
          },
        },
      };
    }

    const eventsRaw = parsed.data.events;
    if (eventsRaw.length === 0) {
      // Empty batches are valid but trivial.
      return { status: 200, body: { accepted: [], rejected: [] } };
    }

    if (eventsRaw.length > deps.ingestConfig.maxBatchEvents) {
      return {
        status: 413,
        body: {
          accepted: [],
          rejected: [],
          error: {
            code: BATCH_REASON_INVALID_REQUEST,
            message: `batch exceeds the maximum of ${deps.ingestConfig.maxBatchEvents} events`,
          },
        },
      };
    }

    // ---- per-event loop -------------------------------------------------
    const accepted: BatchAcceptedResult[] = [];
    const rejected: BatchRejectedResult[] = [];
    // Collected during the loop, published AFTER the response is built.
    const quarantined: QuarantineCandidate[] = [];
    // Resolved once: every event in a batch shares the API key's project.
    const projectPolicy = deps.policy.resolve(context.auth.projectId);

    // We process events sequentially. Producers send small batches and the
    // SET NX EX hot path is short-circuit cheap; the sequential loop keeps
    // the response order matched to the input order, which downstream SDK
    // mappers rely on. If profiling later shows the loop is a bottleneck
    // we can parallelise with `Promise.all` — each event is independent.
    for (let index = 0; index < eventsRaw.length; index++) {
      const rawEvent = eventsRaw[index];
      // The Zod `events: array(record(...))` shape guarantees each entry
      // is a defined object — `rawEvent === undefined` cannot happen at
      // runtime, but `noUncheckedIndexedAccess` requires the guard.
      if (rawEvent === undefined) continue;
      const eventResult = await processOneEvent(rawEvent, index, context, deps, isolation, now);
      if (eventResult.kind === "accepted") {
        accepted.push(eventResult.accepted);
      } else {
        rejected.push(eventResult.rejected);
        if (deps.quarantine !== undefined) {
          quarantined.push({
            raw: rawEvent,
            rejected: eventResult.rejected,
            projectId: context.auth.projectId,
            environment: context.auth.environment,
            projectPolicy,
          });
        }
      }
    }

    const body = { accepted, rejected };

    // Fire-and-forget, deliberately un-awaited. The producer's answer is
    // already computed; awaiting a broker round trip here would put the
    // quarantine's availability on the ingestion latency path, for a
    // diagnostic about events that are being rejected anyway.
    //
    // `.catch` rather than nothing: the publisher already swallows its own
    // failures, and this is the backstop that keeps a bug in it from
    // becoming an unhandled rejection that takes the process down.
    if (deps.quarantine !== undefined && quarantined.length > 0) {
      void deps.quarantine.publish(quarantined).catch(() => {});
    }

    return { status: 200, body };
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Per-event pipeline
// ---------------------------------------------------------------------------

type PerEventOutcome =
  | { readonly kind: "accepted"; readonly accepted: BatchAcceptedResult }
  | { readonly kind: "rejected"; readonly rejected: BatchRejectedResult };

async function processOneEvent(
  raw: Readonly<Record<string, unknown>>,
  index: number,
  context: IngestRequestContext,
  deps: IngestHandlerDeps,
  isolation: SyncIsolationLookup,
  now: () => Date,
): Promise<PerEventOutcome> {
  const auth = context.auth;
  // ---- stamp trusted metadata BEFORE any other operation ----------------
  // Producers may have sent project_id/environment/ingested_at/source.id;
  // we overwrite them from the API key tuple per `01-event-contract.md`
  // "Trusted Metadata". We never trust producer-supplied values for these
  // fields, even if they happen to match — overwriting is unconditional.
  const stamped = stampTrustedMetadata(raw, context, auth);
  const eventIdHint = readStringField(raw, "event_id");
  // Read before validation, because the two rejections below happen before
  // validation. `eventLabel` is what keeps a producer-supplied string from
  // reaching a metric as-is.
  const rawEventLabel = eventLabel(readStringField(raw, "event"), deps.catalog);

  // ---- forbidden-field policy ------------------------------------------
  // Run the policy BEFORE catalog validation so a producer leaking a
  // forbidden field cannot blow up the validator path with a redacted
  // structure, and BEFORE any structured log line for the event is
  // emitted (per the doc).
  const override = deps.policy.resolve(auth.projectId);
  const evaluateOptions = override !== undefined ? { projectPolicy: override } : {};
  const decision: PolicyDecision = evaluate(stamped, evaluateOptions);
  if (decision.decision === "reject") {
    const rejected = buildRejected({
      ...(eventIdHint !== undefined ? { eventId: eventIdHint } : {}),
      code: BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
      detail: {
        path: [...decision.path],
        policy_reason: decision.reason,
        message: `forbidden field '${decision.path.join(".")}' present (policy reason: ${decision.reason})`,
      },
    });
    deps.metrics.incrementRejected({
      project_id: auth.projectId,
      environment: auth.environment,
      reason: POLICY_BATCH_REASON_FORBIDDEN_FIELD_REJECTED,
      event: rawEventLabel,
    });
    return { kind: "rejected", rejected };
  }

  // ---- apply redactions + emit pattern metric -------------------------
  const redactedEvent = applyRedactions(stamped, decision.redactions);
  emitAllRedactionMetrics(
    decision.redactions,
    { project_id: auth.projectId, environment: auth.environment },
    {
      incrementCounter: (increment: PatternRedactionMetricIncrement) =>
        deps.metrics.incrementPatternRedaction(increment),
      logger: { debug: deps.logger.debug.bind(deps.logger) },
    },
  );

  // ---- envelope + per-version catalog validation ----------------------
  const catalogResult = validateCatalogEvent(redactedEvent, deps.catalog, { now: now() });
  if (!catalogResult.ok) {
    const rejected = buildRejected({
      ...(eventIdHint !== undefined ? { eventId: eventIdHint } : {}),
      code: catalogResult.code,
      ...(catalogResult.detail !== undefined ? { detail: { ...catalogResult.detail } } : {}),
    });
    deps.metrics.incrementRejected({
      project_id: auth.projectId,
      environment: auth.environment,
      reason: catalogResult.code,
      event: rawEventLabel,
    });
    return { kind: "rejected", rejected };
  }

  const envelope: Envelope = catalogResult.event;

  if (catalogResult.deprecated) {
    deps.metrics.incrementDeprecatedSchemaVersion({
      event: envelope.event,
      schema_version: envelope.schema_version,
    });
  }

  // ---- short-window dedupe -------------------------------------------
  // A LEASE, not a record. The entry has to be written before the publish to
  // keep a retry storm's second copy off the broker, which means a failed
  // publish would otherwise leave a claim standing over an event that does
  // not exist — and the client, following the `retry the event` instruction
  // below, would get `duplicate` and lose it. So the claim is short-lived
  // and the publish path closes it either way. See ../dedupe/types.ts.
  const windowSec = deps.projectConfig.dedupeWindowSec(auth.projectId, envelope.environment);
  const dedupeKey = {
    projectId: envelope.project_id,
    environment: envelope.environment,
    eventId: envelope.event_id,
  };
  const claim = await deps.dedupe.claim({ ...dedupeKey, ttlSec: DEDUPE_LEASE_TTL_SEC });
  /** Only a real lease can be promoted or dropped; `skipped` took none. */
  const holdsLease = claim.status === "claimed";
  if (claim.status === "in_progress") {
    // Another request holds an unresolved lease. The platform does NOT have
    // the event yet, so this is retryable — answering `duplicate` here is the
    // lie that used to make producers discard events that were never stored.
    deps.metrics.incrementRejected({
      project_id: envelope.project_id,
      environment: envelope.environment,
      reason: BATCH_REASON_IN_PROGRESS,
      event: envelope.event,
    });
    return {
      kind: "rejected",
      rejected: buildRejected({
        eventId: envelope.event_id,
        code: BATCH_REASON_IN_PROGRESS,
        detail: {
          event: envelope.event,
          message: "another request is publishing this event_id; retry shortly",
        },
      }),
    };
  }
  if (claim.status === "duplicate") {
    deps.metrics.incrementDedupeHit({
      project_id: envelope.project_id,
      environment: envelope.environment,
    });
    deps.metrics.incrementRejected({
      project_id: envelope.project_id,
      environment: envelope.environment,
      reason: BATCH_REASON_DUPLICATE,
      event: envelope.event,
    });
    return {
      kind: "rejected",
      rejected: buildRejected({
        eventId: envelope.event_id,
        code: BATCH_REASON_DUPLICATE,
        detail: {
          event: envelope.event,
          message: "event_id observed within the ingester dedupe window",
        },
      }),
    };
  }
  if (claim.status === "skipped") {
    deps.metrics.incrementDedupeSkipped({
      project_id: envelope.project_id,
      environment: envelope.environment,
    });
    // Continue: dedupe is a retry-storm absorber; downstream remains
    // canonically idempotent. The log line is a single per-event warn
    // so operators can correlate with the Redis alert.
    deps.logger.warn(
      {
        component: "ingest.dedupe",
        project_id: envelope.project_id,
        environment: envelope.environment,
        reason: claim.reason,
      },
      "dedupe claim skipped",
    );
  }

  // ---- publish to raw.events -----------------------------------------
  try {
    const partitionKey = buildRawEventsPartitionKey({
      project_id: envelope.project_id,
      environment: envelope.environment,
      event_id: envelope.event_id,
      identity: envelope.identity,
    });
    await deps.producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      event: envelope,
      isolation,
      partitionKey,
    });
    // Durable now, so the lease becomes the real dedupe window. Deliberately
    // not awaited: a failed promotion lets a duplicate through after the
    // lease expires, which this layer is explicitly allowed to do, and the
    // ingest response should not pay a Redis round trip for it.
    if (holdsLease) void deps.dedupe.confirm({ ...dedupeKey, ttlSec: windowSec });
    deps.metrics.incrementPublishSuccess({
      project_id: envelope.project_id,
      environment: envelope.environment,
      topic: STREAM_FAMILY_RAW_EVENTS,
    });
    deps.metrics.incrementAccepted({
      project_id: envelope.project_id,
      environment: envelope.environment,
      // Post-validation, so the name is a catalog event by construction —
      // `validateCatalogEvent` rejected everything else above.
      event: envelope.event,
    });
    deps.logger.info(
      {
        component: "ingest",
        project_id: envelope.project_id,
        environment: envelope.environment,
        event: envelope.event,
        schema_version: envelope.schema_version,
        event_id: envelope.event_id,
        deprecated: catalogResult.deprecated,
        request_id: context.requestId,
        batch_index: index,
      },
      "ingest accepted",
    );
    const result: BatchAcceptedResult = catalogResult.deprecated
      ? { event_id: envelope.event_id, status: "accepted", deprecated: true }
      : { event_id: envelope.event_id, status: "accepted" };
    return { kind: "accepted", accepted: result };
  } catch (err) {
    const error = err as Error;
    // Awaited, unlike `confirm`: the response we are about to write tells the
    // client to retry, and that retry hits this lease. Dropping it first is
    // what makes the instruction true.
    if (holdsLease) await deps.dedupe.release(dedupeKey);
    deps.logger.error(
      {
        component: "ingest.publish",
        project_id: envelope.project_id,
        environment: envelope.environment,
        event: envelope.event,
        event_id: envelope.event_id,
        err: { name: error.name, message: error.message },
      },
      "raw.events publish failed",
    );
    deps.metrics.incrementPublishFailed({
      project_id: envelope.project_id,
      environment: envelope.environment,
      topic: STREAM_FAMILY_RAW_EVENTS,
      reason: error.name || "UnknownError",
    });
    deps.metrics.incrementRejected({
      project_id: envelope.project_id,
      environment: envelope.environment,
      reason: BATCH_REASON_PUBLISH_FAILED,
      event: envelope.event,
    });
    return {
      kind: "rejected",
      rejected: buildRejected({
        eventId: envelope.event_id,
        code: BATCH_REASON_PUBLISH_FAILED,
        detail: { event: envelope.event, message: "raw.events publish failed; retry the event" },
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical envelope from the producer-sent shape by overwriting
 * the platform-stamped fields. The function does not validate the result
 * against the envelope schema — `validateCatalogEvent` does that on the
 * next step.
 *
 * Trusted-field overrides (in order):
 *   - project_id   <- API key
 *   - environment  <- API key
 *   - ingested_at  <- `now()` (UTC ISO 8601)
 *   - source.id    <- API key (preserves producer-sent `type`, `sdk`,
 *                     `sdk_version` when present)
 */
function stampTrustedMetadata(
  raw: Readonly<Record<string, unknown>>,
  context: IngestRequestContext,
  auth: IngestRequestContext["auth"],
): Record<string, unknown> {
  // Shallow clone so we never mutate the caller's object.
  const out: Record<string, unknown> = { ...raw };

  out["project_id"] = auth.projectId;
  out["environment"] = auth.environment;
  out["ingested_at"] = context.receivedAt.toISOString();

  const incomingSource = raw["source"];
  if (incomingSource !== null && typeof incomingSource === "object") {
    const src = { ...(incomingSource as Record<string, unknown>) };
    src["id"] = auth.source.id;
    // Producers may set their own `type`; the doc lets it through. If
    // producer omitted `type`, fall back to the API key's source type.
    if (!Object.hasOwn(src, "type") || typeof src["type"] !== "string") {
      src["type"] = auth.source.type;
    }
    out["source"] = src;
  } else {
    out["source"] = { id: auth.source.id, type: auth.source.type };
  }

  return out;
}

function readStringField(raw: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildRejected(input: {
  readonly eventId?: string;
  readonly code: BatchReasonCode;
  readonly detail?: BatchRejectedResult["detail"];
}): BatchRejectedResult {
  // The batch response schema requires `event_id` to be a UUID. When a
  // producer sent an event without a valid event_id we cannot honour that
  // contract for this entry, so we fall back to the all-zero UUID. The
  // detail still carries the validation message that explains the
  // problem; this matches the docs' "stable machine-readable reason
  // codes" requirement and the SDK retry rules.
  const eventId =
    input.eventId !== undefined && /^[0-9a-f-]{36}$/i.test(input.eventId)
      ? input.eventId
      : "00000000-0000-0000-0000-000000000000";
  const out: BatchRejectedResult = {
    event_id: eventId,
    status: "rejected",
    code: input.code as BatchReasonCode,
    // Derived, never passed in: a caller that could choose its own value is a
    // caller that can get it wrong, and this flag decides whether a producer
    // keeps the event or throws it away.
    retryable: isRetryableBatchReason(input.code),
  };
  if (input.detail !== undefined) {
    return { ...out, detail: input.detail };
  }
  return out;
}
