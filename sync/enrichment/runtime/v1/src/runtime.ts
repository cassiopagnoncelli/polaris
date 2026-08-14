/**
 * Enrichment stage runtime: consume `identified.events`, enrich, publish
 * `resolved.events`.
 *
 * Stage 3 of the main pipeline, and the read-only half of the spine. The
 * ownership line the whole two-stage split exists to draw:
 *
 *   THE IDENTITY STAGE IS THE PROFILE STORE'S ONLY WRITER.
 *   THIS STAGE ONLY READS.
 *
 * It is enforced structurally, not by convention — the traits enricher's
 * package exports a reader and nothing else, and this runtime holds no
 * database handle it could write through. A test asserts the same thing
 * from the outside, because a structural guarantee nobody checks is one
 * refactor away from being a comment.
 *
 * ## Why the enrichers run in-process
 *
 * One broker hop for the whole stage, however many enrichers it grows.
 * The alternative — a hop per enricher — would multiply the spine's
 * latency and storage by the enricher count for no isolation benefit:
 * these are pure, read-only functions over one envelope, and the failure
 * they can cause (a slow geo lookup) is not one that partition
 * boundaries would contain anyway. The composition mirrors how a
 * destination consumer runs normalize → map → deliver in one process.
 *
 * ## Failure posture: enrich what you can, always emit
 *
 * An enricher that cannot answer produces a null-ish block with
 * provenance, never an exception that stalls the partition. Geo is
 * decoration; traits are "latest as of delivery" and a delivery with no
 * traits is still a delivery. What would be unacceptable is the spine
 * stopping — every destination sits behind it — so the only errors that
 * propagate here are the ones that mean the process itself is broken
 * (the transport, the database connection), which is exactly when a
 * redelivery is the right answer.
 */

import type { Logger } from "@polaris/shared-logger";
import { STREAM_FAMILY_RESOLVED_EVENTS, buildProfilePartitionKey } from "@polaris/shared-transport";
import { type IPLookup, enrichGeo } from "@polaris/sync-enrichment-geoip-v1";
import { type ProfileReader, enrichTraits } from "@polaris/sync-enrichment-traits-v1";

import { buildResolvedEvent } from "./emit.js";
import type { EnrichmentPolicy } from "./policy.js";

export interface PublishTarget {
  publishEvent(input: {
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }): Promise<unknown>;
}

/**
 * The slice of processor metrics this stage reports. Declared
 * structurally so tests need not construct a metrics object they do not
 * exercise; `app.ts` passes the real one.
 */
/**
 * Per-event scope every metric this stage emits carries. Same contract
 * and same reasoning as the identity stage's: read off the EVENT, never
 * off the service config, because one deployment can see more than one
 * project and the activation gate already decides per event.
 */
export interface StageMetricScope {
  readonly project_id: string;
  readonly environment: string;
  readonly topic_family: string;
  readonly partition?: number | string | undefined;
}

export interface EnrichmentStageMetrics {
  readonly onConsumed?: (scope: StageMetricScope) => void;
  readonly onEmitted?: (scope: StageMetricScope) => void;
  readonly onSkipped?: (scope: StageMetricScope, reason: string) => void;
  readonly onFailed?: (scope: StageMetricScope, reason: string) => void;
  readonly onHandlerDurationMs?: (scope: StageMetricScope, ms: number) => void;
  readonly onLag?: (scope: StageMetricScope, ingestedAt: string) => void;
  /**
   * What each enricher resolved, as `<enricher>:<kind>` — e.g.
   * `traits:resolved`, `geo:no_ip`. Both enrichers fail open, so their
   * outcomes are invisible in the failure counters by design; this is
   * the only place a geo outage is distinguishable from a population of
   * server-side events with no IP.
   */
  readonly onOutcome?: (scope: StageMetricScope, outcome: string) => void;
}

export interface EnrichmentStageDeps {
  /** Read-only. There is deliberately no writer here. */
  readonly reader: ProfileReader;
  readonly lookup: IPLookup;
  readonly producer: PublishTarget;
  readonly logger: Logger;
  readonly metrics?: EnrichmentStageMetrics;
  readonly policyFor: (projectId: string, environment: string) => EnrichmentPolicy;
  readonly runId: () => string | null;
  readonly now: () => Date;
}

/** What the stage did with one event, so callers and tests can assert. */
export interface EnrichmentResult {
  readonly profileId: string | null;
  readonly traitsKind: "resolved" | "over_cap" | "empty" | "missing" | "unprofiled";
  readonly geoKind: "hit" | "miss" | "no_backend" | "no_ip";
  readonly partitionKey: string;
}

/**
 * Enrich one event and publish it.
 *
 * The two enrichers run CONCURRENTLY. They are independent — disjoint
 * output slots, no shared state, one does I/O and the other does not —
 * so serialising them would add the database round-trip and the mmdb
 * walk together on every event for no ordering benefit.
 */
export async function handleEvent(
  deps: EnrichmentStageDeps,
  raw: Record<string, unknown>,
  scope?: StageMetricScope,
): Promise<EnrichmentResult> {
  const projectId = String(raw["project_id"] ?? "");
  const environment = String(raw["environment"] ?? "");
  const eventId = String(raw["event_id"] ?? "");
  const labels: StageMetricScope = scope ?? {
    project_id: projectId,
    environment,
    topic_family: STREAM_FAMILY_IDENTIFIED_EVENTS,
  };
  const policy = deps.policyFor(projectId, environment);

  const profile = raw["profile"] as Record<string, unknown> | null | undefined;
  const profileId =
    profile === null || profile === undefined ? null : String(profile["profile_id"] ?? "") || null;
  const context = raw["context"] as Record<string, unknown> | null | undefined;

  const [traits, geo] = await Promise.all([
    enrichTraits({ profileId, reader: deps.reader }, { maxTraitsBytes: policy.maxTraitsBytes }),
    Promise.resolve(enrichGeo({ ip: context?.["ip"], lookup: deps.lookup })),
  ]);

  if (traits.kind === "over_cap") {
    // The event still ships, carrying `traits: null`. Truncating would
    // hand destinations a snapshot that looks complete and is not.
    deps.logger.warn(
      {
        event_id: eventId,
        project_id: projectId,
        profile_id: profileId,
        traits_version: traits.traitsVersion,
        max_bytes: policy.maxTraitsBytes,
      },
      "profile traits exceeded the snapshot guard; event enriched with traits: null",
    );
    deps.metrics?.onSkipped?.(labels, "traits_over_cap");
  }
  if (traits.kind === "missing") {
    // The identity stage commits before publishing, so this is not a
    // race: the row is genuinely gone (deleted, or the event was
    // replayed from an archive older than the store).
    deps.logger.warn(
      { event_id: eventId, project_id: projectId, profile_id: profileId },
      "no profile row for the stamped profile_id; event enriched without traits",
    );
    deps.metrics?.onSkipped?.(labels, "profile_missing");
  }

  const resolved = buildResolvedEvent(
    raw,
    { traits: traits.traits, traitsVersion: traits.traitsVersion, geo: geo.geo },
    deps.runId(),
    deps.now(),
  );

  // Keyed exactly as the identity stage keyed it, so one person keeps
  // one partition across both spine families.
  const partitionKey = buildProfilePartitionKey({
    project_id: projectId,
    environment,
    profile_id: profileId,
    event_id: eventId,
  });

  await deps.producer.publishEvent({
    family: STREAM_FAMILY_RESOLVED_EVENTS,
    event: resolved,
    partitionKey,
  });
  deps.metrics?.onEmitted?.(labels);
  deps.metrics?.onOutcome?.(labels, `traits:${traits.kind}`);
  deps.metrics?.onOutcome?.(labels, `geo:${geo.kind}`);

  return {
    profileId,
    traitsKind: traits.kind,
    geoKind: geo.kind,
    partitionKey,
  };
}

// ---------------------------------------------------------------------
// Streaming runtime
// ---------------------------------------------------------------------

import {
  type PolarisConsumer,
  STREAM_FAMILY_IDENTIFIED_EVENTS,
  type TransportMessageHandler,
  consumerFamiliesFor,
  decodeEvent,
} from "@polaris/shared-transport";

export interface EnrichmentStageRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for tests that drive one message without a broker. */
  readonly handler: TransportMessageHandler;
}

export interface EnrichmentStageRuntimeDeps extends EnrichmentStageDeps {
  readonly consumer: PolarisConsumer;
  /**
   * Projects with isolated `identified.events.<project_id>` streams to
   * consume alongside the shared family.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /**
   * Per-message activation gate. `false` skips the event entirely: a
   * disabled stage must not emit a half-enriched event that downstream
   * consumers would treat as authoritative.
   */
  readonly isEnabled?: (projectId: string, environment: string) => Promise<boolean> | boolean;
}

export function createRuntime(deps: EnrichmentStageRuntimeDeps): EnrichmentStageRuntime {
  const isolatedProjects = deps.isolatedProjects ?? [];

  const handler: TransportMessageHandler = async (payload) => {
    // Tombstones are skipped, not failed: nothing to enrich, and
    // throwing would rewind the partition on a message that will never
    // decode.
    const value = payload.message.value;
    if (value === null) return;
    const raw = decodeEvent(value) as Record<string, unknown>;

    const labels: StageMetricScope = {
      project_id: String(raw["project_id"] ?? ""),
      environment: String(raw["environment"] ?? ""),
      topic_family: payload.family,
      partition: payload.partition,
    };

    if (deps.isEnabled !== undefined) {
      const enabled = await deps.isEnabled(labels.project_id, labels.environment);
      if (!enabled) {
        deps.metrics?.onSkipped?.(labels, "processor_disabled");
        return;
      }
    }

    const ingestedAt = raw["ingested_at"];
    if (typeof ingestedAt === "string") deps.metrics?.onLag?.(labels, ingestedAt);
    deps.metrics?.onConsumed?.(labels);

    const startedAt = Date.now();
    try {
      await handleEvent(deps, raw, labels);
    } catch (err) {
      deps.metrics?.onFailed?.(labels, "handler_error");
      throw err;
    } finally {
      deps.metrics?.onHandlerDurationMs?.(labels, Date.now() - startedAt);
    }
  };

  let started = false;
  return {
    handler,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const families = consumerFamiliesFor(STREAM_FAMILY_IDENTIFIED_EVENTS, isolatedProjects);
      await deps.consumer.subscribe({ families: [...families] });
      deps.logger.info(
        { component: "sync-enrichment.runtime", families, isolated_projects: isolatedProjects },
        "enrichment stage subscribed to identified.events",
      );
      await deps.consumer.runEach(handler);
    },
    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      await deps.consumer.disconnect();
    },
  };
}
