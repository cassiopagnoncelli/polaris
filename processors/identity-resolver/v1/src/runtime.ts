/**
 * Streaming runtime: wires KafkaJS consumer → resolver → KafkaJS producer
 * and `identity_links` table.
 *
 * Shape mirrors `processors/analytics-projector/v1/src/runtime.ts` so every
 * Polaris processor uses the same per-message contract:
 *
 *   1. Subscribe a `PolarisConsumer` to the `raw.events` topic family
 *      (plus any isolated per-project topics).
 *
 *   2. For each message:
 *        - decode the canonical envelope,
 *        - validate the minimum envelope fields the resolver needs,
 *        - run the pure `resolveIdentityCandidate` transform,
 *        - branch on the candidate kind:
 *            * `none` — no overlap; record a metric and return.
 *            * `authoritative_overlap` — consult `identity_links`, decide
 *              whether the link is new (linked), conflicts with an existing
 *              binding (merged), or rotates a rotating identifier under a
 *              stable strong identifier (rotated). Insert the new row and
 *              supersede the prior row when applicable.
 *        - build the canonical identity.linked / merged / rotated envelope
 *          and publish it to `identity.events` via `PolarisProducer`,
 *        - record consume / emit / failure counters on
 *          `@polaris/shared-processor`'s `ProcessorMetrics`,
 *        - on error: classify via the shared `classifyError`, increment
 *          the failed counter, and re-throw so KafkaJS surfaces the
 *          failure through its own retry path.
 *
 * The runtime accepts the repository as a dependency so tests inject the
 * in-memory adapter and production wires the Kysely adapter via the boot
 * layer. The runtime never opens database connections itself.
 *
 * Caller-owned DLQ orchestration: the runtime does not auto-route to DLQ.
 * Hosts that want DLQ routing wrap the handler with `publishToDlq` from
 * `@polaris/shared-processor`.
 */

import {
  buildRawEventsPartitionKey,
  consumerTopicsForFamily,
  decodeEvent,
  type PolarisConsumer,
  type PolarisEachMessageHandler,
  type PolarisMessageContext,
  type PolarisProducer,
  type SyncIsolationLookup,
  sharedOnlyIsolationLookup,
  TOPIC_FAMILY_IDENTITY_EVENTS,
  TOPIC_FAMILY_RAW_EVENTS,
} from "@polaris/shared-kafka";
import type { Logger } from "@polaris/shared-logger";
import {
  classifyError,
  type ProcessorMetricLabels,
  ProcessorMetrics,
  type ProcessorRetryClassification,
} from "@polaris/shared-processor";
import { v7 as uuidv7 } from "uuid";
import {
  buildIdentityEventEnvelope,
  type IdentityEventEmission,
  type IdentityEventName,
} from "./emit.js";
import type { IdentityLinkRepository } from "./repository.js";
import {
  EVIDENCE_TYPE_EXPLICIT_OVERLAP,
  formatIdentifier,
  PROCESSOR_IDENTITY,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  resolveIdentityCandidate,
} from "./transform.js";
import type { RawEventEnvelope } from "./types.js";

/**
 * Dependencies for the runtime. The factory accepts already-built
 * consumer/producer so the binary entry point owns lifecycle wiring,
 * tests can inject in-memory fakes, and the runtime stays a pure function
 * of its inputs.
 */
export interface IdentityResolverRuntimeDeps {
  readonly consumer: PolarisConsumer;
  readonly producer: PolarisProducer;
  readonly repository: IdentityLinkRepository;
  readonly logger: Logger;
  /**
   * Sync isolation lookup. Defaults to `sharedOnlyIsolationLookup`. Every
   * project flows through the shared topics until the isolation control
   * plane (P11-008) wires the PostgreSQL adapter.
   */
  readonly isolation?: SyncIsolationLookup;
  /**
   * Projects currently isolated for `raw.events`. The consumer subscribes
   * to their dedicated topics in addition to the shared one.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /** Override for `Date.now()` so tests can pin emission timestamps. */
  readonly now?: () => Date;
  /** KafkaJS `partitionsConsumedConcurrently`. Forwarded into `runEach`. */
  readonly partitionsConsumedConcurrently?: number;
  /**
   * `ProcessorMetrics` registry. The runtime increments consume / emit /
   * failure counters here. Defaults to a fresh registry so tests still
   * observe their own metrics.
   */
  readonly metrics?: ProcessorMetrics;
  /**
   * Per-run identifier (UUIDv7). Stamped onto every emitted identity.*
   * event in both the nested `processor.run_id` slot and the property
   * `run_id` field.
   */
  readonly run_id?: string | undefined;
  /**
   * UUIDv7 allocator. Tests inject a deterministic counter; production
   * uses the real `uuidv7()`.
   */
  readonly newEventId?: () => string;
}

/** Runtime handle returned by `createRuntime`. */
export interface IdentityResolverRuntime {
  /** Subscribe and start consuming. Idempotent. */
  start(): Promise<void>;
  /** Stop the underlying consumer. Idempotent. */
  stop(): Promise<void>;
  /**
   * Expose the message handler for direct testing without a running
   * KafkaJS cluster.
   */
  readonly handler: PolarisEachMessageHandler;
  /** Metrics registry the runtime is wired to. */
  readonly metrics: ProcessorMetrics;
}

/**
 * Build the streaming runtime. The factory does not connect the consumer
 * or producer — the binary entry point owns connection lifecycle.
 */
export function createRuntime(deps: IdentityResolverRuntimeDeps): IdentityResolverRuntime {
  const isolation = deps.isolation ?? sharedOnlyIsolationLookup;
  const isolatedProjects = deps.isolatedProjects ?? [];
  const metrics = deps.metrics ?? new ProcessorMetrics();
  const newEventId = deps.newEventId ?? ((): string => uuidv7());

  const handler: PolarisEachMessageHandler = async (payload, context) => {
    await handleMessage({
      payload,
      context,
      producer: deps.producer,
      repository: deps.repository,
      logger: deps.logger,
      isolation,
      metrics,
      newEventId,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.run_id !== undefined ? { run_id: deps.run_id } : {}),
    });
  };

  let started = false;
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    const topics = consumerTopicsForFamily(TOPIC_FAMILY_RAW_EVENTS, isolatedProjects);
    await deps.consumer.subscribe({ topics: [...topics], fromBeginning: false });
    deps.logger.info(
      {
        component: "identity-resolver.runtime",
        topics,
        isolated_projects: isolatedProjects,
      },
      "identity-resolver subscribed to raw.events",
    );
    await deps.consumer.runEach(handler, {
      ...(deps.partitionsConsumedConcurrently !== undefined
        ? { partitionsConsumedConcurrently: deps.partitionsConsumedConcurrently }
        : {}),
    });
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    await deps.consumer.disconnect();
  }

  return { start, stop, handler, metrics };
}

// ---------------------------------------------------------------------------
// Per-message pipeline
// ---------------------------------------------------------------------------

interface HandleMessageInput {
  readonly payload: Parameters<PolarisEachMessageHandler>[0];
  readonly context: PolarisMessageContext;
  readonly producer: PolarisProducer;
  readonly repository: IdentityLinkRepository;
  readonly logger: Logger;
  readonly isolation: SyncIsolationLookup;
  readonly metrics: ProcessorMetrics;
  readonly newEventId: () => string;
  readonly now?: () => Date;
  readonly run_id?: string | undefined;
}

async function handleMessage(input: HandleMessageInput): Promise<void> {
  const { payload, context, producer, repository, logger, isolation, metrics, newEventId, now } =
    input;
  const value = payload.message.value;
  if (value === null || value.length === 0) {
    // Tombstone-style empty payload. Drop with a warn — see the analytics-
    // projector runtime for the same rationale.
    logger.warn(
      {
        component: "identity-resolver.handler",
        topic: payload.topic,
        partition: payload.partition,
        offset: payload.message.offset,
        ...(context.event_id !== undefined ? { event_id: context.event_id } : {}),
      },
      "skipping empty/tombstone message",
    );
    return;
  }

  let decoded: unknown;
  try {
    decoded = decodeEvent(value);
  } catch (err) {
    handleClassifiedError(err, {
      payload,
      context,
      metrics,
      logger,
      message: "failed to decode raw.events payload",
    });
    throw err;
  }

  const raw = assertEnvelope(decoded);
  if (raw === undefined) {
    const fail = new Error(
      "identity-resolver: raw.events payload missing required envelope fields",
    );
    handleClassifiedError(fail, {
      payload,
      context,
      metrics,
      logger,
      message: "raw.events payload missing required envelope fields",
    });
    throw fail;
  }

  const labels: ProcessorMetricLabels = {
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    project_id: raw.project_id,
    environment: raw.environment,
  };

  metrics.incrementConsumed(labels);

  // v1's only rule: explicit overlap. The transform returns `none` when
  // no two strong identifiers are present in the canonical identity block.
  const candidate = resolveIdentityCandidate(raw);
  if (candidate.kind === "none") {
    return;
  }

  const startedAt = Date.now();

  let emission: IdentityEventEmission;
  try {
    emission = await applyExplicitOverlap({
      raw,
      candidate,
      repository,
      now: now ?? ((): Date => new Date()),
      ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
    });
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "identity-resolver.handler",
        project_id: raw.project_id,
        environment: raw.environment,
        event_id: raw.event_id,
        source_topic: payload.topic,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to apply explicit-overlap rule",
    );
    throw err;
  }

  const envelope = buildIdentityEventEnvelope({
    raw,
    emission,
    eventId: newEventId(),
    now: now ?? ((): Date => new Date()),
    ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
  });

  // Reuse the SAME canonical partition key as the source raw.events
  // record so per-identity ordering is preserved end to end (analytics-
  // projector pattern).
  const partitionKey = buildRawEventsPartitionKey({
    project_id: envelope.project_id,
    environment: envelope.environment,
    event_id: envelope.event_id,
    identity: envelope.identity,
  });

  try {
    await producer.publishEvent({
      family: TOPIC_FAMILY_IDENTITY_EVENTS,
      // The identity event envelope is a closed shape on purpose; widen at
      // the producer boundary so `PublishableEvent`'s index signature
      // doesn't pollute the local type.
      event: envelope as unknown as Parameters<typeof producer.publishEvent>[0]["event"],
      isolation,
      partitionKey,
    });
  } catch (err) {
    const classification: ProcessorRetryClassification = classifyError(err);
    metrics.incrementFailed({ ...labels, reason: classification.reason });
    logger.error(
      {
        component: "identity-resolver.handler",
        project_id: envelope.project_id,
        environment: envelope.environment,
        event_id: envelope.event_id,
        source_topic: payload.topic,
        source_partition: payload.partition,
        source_offset: payload.message.offset,
        retry_reason: classification.reason,
        retryable: classification.retryable,
        err: errSummary(err),
      },
      "failed to publish identity event",
    );
    throw err;
  }

  metrics.incrementEmitted(labels);
  metrics.observeHandlerDurationMs(labels, Date.now() - startedAt);

  logger.debug(
    {
      component: "identity-resolver.handler",
      project_id: envelope.project_id,
      environment: envelope.environment,
      event: envelope.event,
      event_id: envelope.event_id,
      link_id: emission.link.link_id,
      source_event_id: raw.event_id,
      source_topic: payload.topic,
      source_partition: payload.partition,
      source_offset: payload.message.offset,
      partition_key: partitionKey,
    },
    "identity event emitted",
  );
}

/**
 * Apply the explicit-overlap rule. Returns the rich emission record the
 * caller turns into an `identity.events` envelope. Pure relative to the
 * repository — the only side effect is `INSERT`/`UPDATE` on the
 * `identity_links` table.
 */
async function applyExplicitOverlap(input: {
  readonly raw: RawEventEnvelope;
  readonly candidate: { readonly kind: "authoritative_overlap" } & {
    readonly left: { readonly kind: string; readonly value: string };
    readonly right: { readonly kind: string; readonly value: string };
  };
  readonly repository: IdentityLinkRepository;
  readonly now: () => Date;
  readonly run_id?: string | undefined;
}): Promise<IdentityEventEmission> {
  const { raw, candidate, repository, now } = input;
  // The transform already ordered the pair so `left.kind <= right.kind`.
  // For v1 (anonymous_id + customer_id), `left = anonymous_id`, `right =
  // customer_id` because `'anonymous_id' < 'customer_id'`.
  const leftId = formatIdentifier(candidate.left.kind as never, candidate.left.value);
  const rightId = formatIdentifier(candidate.right.kind as never, candidate.right.value);

  // Scope every read/write by (project_id, environment) — the canonical
  // graph is project-bounded in v1.
  const scope = { project_id: raw.project_id, environment: raw.environment };

  // 1. Is this exact (left, right) pair already active? If so, the
  //    resolver has already linked it — re-emitting `identity.linked`
  //    would be a duplicate. We classify this as a `linked-idempotent`
  //    emission so the runtime can short-circuit the publish (but still
  //    emit the same canonical event for traceability is preferable).
  //    v1 chooses: emit `identity.linked` again with the existing
  //    `link_id`, so downstream consumers can rely on the event being
  //    present per overlap observation. The DB row is NOT duplicated.
  const existingExact = await repository.findActive({
    ...scope,
    identifier: leftId,
    evidence_type: EVIDENCE_TYPE_EXPLICIT_OVERLAP,
  });
  const exactMatch = existingExact.find(
    (record) => record.left_identifier === leftId && record.right_identifier === rightId,
  );
  if (exactMatch !== undefined) {
    return {
      event_name: "identity.linked",
      link: exactMatch,
      idempotent: true,
    };
  }

  // 2. Look for prior bindings on either half. The runtime branches:
  //    - both halves are previously unbound  → identity.linked (new pair)
  //    - the rotating half (anonymous_id) is bound to a different stable
  //      half (customer_id)                  → identity.merged
  //    - the stable half (customer_id) is bound to a different rotating
  //      half (anonymous_id)                 → identity.rotated
  const leftBindings = await repository.findActive({
    ...scope,
    identifier: leftId,
    evidence_type: EVIDENCE_TYPE_EXPLICIT_OVERLAP,
  });
  const rightBindings = await repository.findActive({
    ...scope,
    identifier: rightId,
    evidence_type: EVIDENCE_TYPE_EXPLICIT_OVERLAP,
  });

  const conflictingLeftBinding = leftBindings.find(
    (record) => record.right_identifier !== rightId && record.left_identifier === leftId,
  );
  const conflictingRightBinding = rightBindings.find(
    (record) => record.left_identifier !== leftId && record.right_identifier === rightId,
  );

  const inserted = await repository.insertLink({
    ...scope,
    left_identifier: leftId,
    right_identifier: rightId,
    confidence: "authoritative",
    evidence_type: EVIDENCE_TYPE_EXPLICIT_OVERLAP,
    evidence: {
      source_event_id: raw.event_id,
      source_event_name: raw.event,
      source_schema_version: raw.schema_version,
    },
    reason: `explicit overlap observed in event ${raw.event} (${raw.event_id})`,
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    ...(input.run_id !== undefined ? { run_id: input.run_id } : {}),
    created_at: now(),
  });

  // Branch order: merge wins if both sides conflict (the new event causes
  // two previously-separate canonical identities to collapse). Otherwise
  // rotation: the strong identifier (right) was previously bound to a
  // different rotating identifier (left) — the user reset their anonymous
  // id while remaining identified.
  if (conflictingLeftBinding !== undefined && conflictingRightBinding !== undefined) {
    const superseded = await repository.supersedeLink({
      link_id: conflictingLeftBinding.link_id,
      superseded_at: now(),
    });
    return {
      event_name: "identity.merged",
      link: inserted,
      superseded,
      idempotent: false,
    };
  }
  if (conflictingLeftBinding !== undefined) {
    const superseded = await repository.supersedeLink({
      link_id: conflictingLeftBinding.link_id,
      superseded_at: now(),
    });
    return {
      event_name: "identity.merged",
      link: inserted,
      superseded,
      idempotent: false,
    };
  }
  if (conflictingRightBinding !== undefined) {
    const superseded = await repository.supersedeLink({
      link_id: conflictingRightBinding.link_id,
      superseded_at: now(),
    });
    return {
      event_name: "identity.rotated",
      link: inserted,
      superseded,
      idempotent: false,
    };
  }

  return {
    event_name: "identity.linked",
    link: inserted,
    idempotent: false,
  };
}

// `IdentityEventName` is exported from emit.ts but referenced through the
// emission type here. We keep the local re-export to ease test imports.
export type { IdentityEventEmission, IdentityEventName } from "./emit.js";
export { PROCESSOR_IDENTITY };

/**
 * Pull the IdentityEventName names into the export shape for downstream
 * test convenience.
 */
export const IDENTITY_EVENT_NAMES: ReadonlyArray<IdentityEventName> = [
  "identity.linked",
  "identity.merged",
  "identity.rotated",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ClassifiedErrorContext {
  readonly payload: Parameters<PolarisEachMessageHandler>[0];
  readonly context: PolarisMessageContext;
  readonly metrics: ProcessorMetrics;
  readonly logger: Logger;
  readonly message: string;
}

function handleClassifiedError(err: unknown, context: ClassifiedErrorContext): void {
  const classification = classifyError(err);
  context.metrics.incrementFailed({
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    ...(context.context.project_id !== undefined ? { project_id: context.context.project_id } : {}),
    ...(context.context.environment !== undefined
      ? { environment: context.context.environment }
      : {}),
    reason: classification.reason,
  });
  context.logger.error(
    {
      component: "identity-resolver.handler",
      topic: context.payload.topic,
      partition: context.payload.partition,
      offset: context.payload.message.offset,
      retry_reason: classification.reason,
      retryable: classification.retryable,
      ...(context.context.event_id !== undefined ? { event_id: context.context.event_id } : {}),
      err: errSummary(err),
    },
    context.message,
  );
}

function assertEnvelope(decoded: unknown): RawEventEnvelope | undefined {
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return undefined;
  }
  const obj = decoded as Record<string, unknown>;
  if (typeof obj["event_id"] !== "string") return undefined;
  if (typeof obj["event"] !== "string") return undefined;
  if (typeof obj["schema_version"] !== "number") return undefined;
  if (typeof obj["project_id"] !== "string") return undefined;
  if (typeof obj["environment"] !== "string") return undefined;
  if (typeof obj["occurred_at"] !== "string") return undefined;
  if (typeof obj["ingested_at"] !== "string") return undefined;
  if (obj["source"] === null || typeof obj["source"] !== "object") return undefined;
  if (obj["identity"] === null || typeof obj["identity"] !== "object") return undefined;
  if (obj["context"] === null || typeof obj["context"] !== "object") return undefined;
  if (obj["properties"] === null || typeof obj["properties"] !== "object") return undefined;
  return obj as unknown as RawEventEnvelope;
}

function errSummary(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}
