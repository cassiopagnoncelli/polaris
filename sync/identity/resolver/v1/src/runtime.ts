/**
 * Identity stage runtime: consume `raw.events`, resolve, publish.
 *
 * The per-message pipeline is deliberately small, because the hard parts
 * live elsewhere: identifier collection is pure (`transform.ts`), the
 * resolution decision is one transaction (`repository.ts`), and envelope
 * construction is pure (`emit.ts`). What this module owns is ORDER.
 *
 * The ordering rule, stated once so it is never re-litigated in a review:
 *
 *   RESOLVE (commit) → PUBLISH SPINE → PUBLISH DERIVED
 *
 * The transaction must commit before the spine event is published,
 * because the enrichment stage reads `profiles` by the id this stage
 * stamped. Publishing first opens a window where a downstream reader
 * looks up a profile that does not exist yet — and no amount of
 * partition ordering closes it, because the two stages are separate
 * processes against the same database.
 *
 * The reverse risk (commit succeeds, publish fails) is the safe
 * direction: the message is redelivered, the transaction re-runs, and
 * every step of it is an upsert or a no-op. That asymmetry is why the
 * order is this way round and not the other.
 */

import type { Logger } from "@polaris/shared-logger";
import {
  STREAM_FAMILY_IDENTIFIED_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_PROFILE_EVENTS,
  buildProfilePartitionKey,
} from "@polaris/shared-transport";

import {
  buildIdentityLinkedEvent,
  buildIdentityMergedEvent,
  buildLinkRejectedEvent,
  buildMergeSuspendedEvent,
  buildProfileUpdatedEvent,
  buildSpineEvent,
} from "./emit.js";
import type { ProfileRepository, ResolutionResult } from "./repository.js";
import {
  type IdentityPolicy,
  type IdentityStageEvent,
  collectIdentifiers,
  extractTraits,
} from "./transform.js";

export interface PublishTarget {
  publishEvent(input: {
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }): Promise<unknown>;
}

/**
 * The slice of processor metrics this stage reports.
 *
 * Declared structurally rather than importing `ProcessorMetrics` whole:
 * the runtime needs two counters, and depending on the full interface
 * would make every test construct a metrics object it does not exercise.
 * `app.ts` passes the real one.
 */
export interface IdentityStageMetrics {
  readonly onEmitted?: () => void;
  readonly onSkipped?: (reason: string) => void;
  /**
   * What the stage DECIDED for this event: `created`, `bound`, `merged`
   * or `unidentified`. Distinct from `onEmitted` because a merge and an
   * ordinary bind both emit one spine event, and only one of them is the
   * failure mode the safeguards exist to catch.
   */
  readonly onOutcome?: (outcome: string) => void;
}

export interface IdentityStageDeps {
  readonly repository: ProfileRepository;
  readonly producer: PublishTarget;
  readonly logger: Logger;
  readonly metrics?: IdentityStageMetrics;
  readonly policyFor: (projectId: string, environment: string) => IdentityPolicy;
  readonly runId: () => string | null;
  readonly now: () => Date;
}

/**
 * Handle one inbound event.
 *
 * Returns the resolution so callers (and tests) can assert on it without
 * reaching into the producer.
 */
export async function handleEvent(
  deps: IdentityStageDeps,
  raw: Record<string, unknown>,
): Promise<ResolutionResult> {
  const projectId = String(raw["project_id"] ?? "");
  const environment = String(raw["environment"] ?? "");
  const eventId = String(raw["event_id"] ?? "");
  const policy = deps.policyFor(projectId, environment);
  const now = deps.now();
  const runId = deps.runId();

  const event = raw as unknown as IdentityStageEvent;
  const collected = collectIdentifiers(event, policy);
  const { traits, overCap } = extractTraits(event, policy);

  if (overCap) {
    // The event still resolves and still binds identifiers — losing an
    // identity link over a payload-size problem would be the worse
    // outcome. The traits simply do not land.
    deps.logger.warn(
      { event_id: eventId, project_id: projectId, max_bytes: policy.maxTraitsBytes },
      "identify traits exceeded the size guard; identifiers still bound, traits dropped",
    );
    deps.metrics?.onSkipped?.("traits_over_cap");
  }

  // ---- resolve (transaction commits before anything is published) ----
  const resolution = await deps.repository.resolveProfile({
    projectId,
    environment,
    identifiers: collected.identifiers,
    traits,
    sourceEventId: eventId,
    sourceEventName: String(raw["event"] ?? ""),
    runId,
    policy,
    now,
  });

  // ---- publish the spine event ----
  const spine = buildSpineEvent(
    raw,
    resolution.profileId === null
      ? null
      : {
          profile_id: resolution.profileId,
          canonical_customer_id: resolution.canonicalCustomerId,
        },
    runId,
    now,
  );

  const partitionKey = buildProfilePartitionKey({
    project_id: projectId,
    environment,
    profile_id: resolution.profileId,
    event_id: eventId,
  });

  await deps.producer.publishEvent({
    family: STREAM_FAMILY_IDENTIFIED_EVENTS,
    event: spine,
    partitionKey,
  });
  deps.metrics?.onEmitted?.();
  // The decision, recorded after the spine publish so a failed publish
  // does not book an outcome the pipeline never saw.
  deps.metrics?.onOutcome?.(resolution.kind);

  // ---- publish derived facts ----
  //
  // After the spine, deliberately. The spine event is what the rest of
  // the pipeline needs to make progress; the facts are observability and
  // downstream bookkeeping. If a derived publish fails, the message is
  // redelivered and the transaction re-runs idempotently — the profile
  // is already correct, and the facts are re-emitted with the same
  // deterministic ids, so ClickHouse collapses the duplicates.
  await publishDerived(
    deps,
    raw,
    resolution,
    collected.denylisted,
    policy,
    runId,
    now,
    partitionKey,
  );

  return resolution;
}

async function publishDerived(
  deps: IdentityStageDeps,
  raw: Record<string, unknown>,
  resolution: ResolutionResult,
  denylisted: readonly { kind: "customer_id" | "anonymous_id"; value: string }[],
  policy: IdentityPolicy,
  runId: string | null,
  now: Date,
  partitionKey: string,
): Promise<void> {
  const identityEvents: Record<string, unknown>[] = [];
  const profileEvents: Record<string, unknown>[] = [];

  if (resolution.merge !== null) {
    identityEvents.push(
      buildIdentityMergedEvent({ source: raw, merge: resolution.merge, runId, now }),
    );
  }

  if (resolution.mergeSuspended !== null) {
    // The breaker tripped. Recorded as a skipped-with-reason so an alert
    // can fire on it: a merge that did not happen is exactly a skip, and
    // it is the signal that a merge storm is underway.
    deps.metrics?.onSkipped?.("merge_suspended");
    identityEvents.push(
      buildMergeSuspendedEvent({
        source: raw,
        profileId: resolution.mergeSuspended.profileId,
        mergeCount: resolution.mergeSuspended.mergeCount,
        mergeLimit: policy.maxMergesPerWindow,
        windowSeconds: policy.mergeWindowSeconds,
        runId,
        now,
      }),
    );
  }

  if (resolution.profileId !== null) {
    for (const bound of resolution.bound) {
      // Only NEW bindings are facts. Re-seeing an identifier already
      // bound to this profile is the steady state, not news — emitting
      // it would put one identity.linked on every event forever.
      if (!bound.newlyBound) continue;
      identityEvents.push(
        buildIdentityLinkedEvent({
          source: raw,
          profileId: resolution.profileId,
          identifier: bound,
          profileCreated: resolution.kind === "created",
          linkId: `${bound.kind}:${bound.value}`,
          runId,
          now,
        }),
      );
    }
  }

  // Denylisted values and cap refusals are both rejections, reported the
  // same way so an operator sees one stream of "a binding did not
  // happen, here is why".
  for (const rejected of denylisted) {
    deps.metrics?.onSkipped?.("link_rejected_denylisted");
    identityEvents.push(
      buildLinkRejectedEvent({
        source: raw,
        profileId: resolution.profileId,
        rejected: { ...rejected, reason: "denylisted" },
        runId,
        now,
      }),
    );
  }
  for (const rejected of resolution.rejected) {
    deps.metrics?.onSkipped?.(`link_rejected_${rejected.reason}`);
    identityEvents.push(
      buildLinkRejectedEvent({
        source: raw,
        profileId: resolution.profileId,
        rejected,
        runId,
        now,
      }),
    );
  }

  if (resolution.traitsPatched && resolution.profileId !== null) {
    profileEvents.push(
      buildProfileUpdatedEvent({
        source: raw,
        profileId: resolution.profileId,
        traitsVersion: resolution.traitsVersion ?? 0,
        traits: (raw["properties"] as Record<string, unknown>) ?? {},
        runId,
        now,
      }),
    );
  }

  for (const event of identityEvents) {
    await deps.producer.publishEvent({
      family: STREAM_FAMILY_IDENTITY_EVENTS,
      event,
      partitionKey,
    });
    deps.metrics?.onEmitted?.();
  }
  for (const event of profileEvents) {
    await deps.producer.publishEvent({
      family: STREAM_FAMILY_PROFILE_EVENTS,
      event,
      partitionKey,
    });
    deps.metrics?.onEmitted?.();
  }
}

// ---------------------------------------------------------------------
// Streaming runtime
//
// Wraps `handleEvent` in the transport lifecycle every processor shares:
// subscribe to the input families, run the handler per message, and stop
// cleanly. Kept separate from `handleEvent` so the behavioural suite can
// exercise the decision logic without a broker.
// ---------------------------------------------------------------------

import {
  type PolarisConsumer,
  STREAM_FAMILY_RAW_EVENTS,
  type TransportMessageHandler,
  consumerFamiliesFor,
  decodeEvent,
} from "@polaris/shared-transport";

export interface IdentityStageRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for tests that drive one message without a broker. */
  readonly handler: TransportMessageHandler;
}

export interface IdentityStageRuntimeDeps extends IdentityStageDeps {
  readonly consumer: PolarisConsumer;
  /**
   * Projects with isolated `raw.events.<project_id>` streams to consume
   * alongside the shared family. This is the ONLY isolation input: the
   * consumer resolves family names itself, so there is deliberately no
   * lookup-function option here — an accepted-but-unread dependency is a
   * trap for the caller who passes it.
   */
  readonly isolatedProjects?: ReadonlyArray<string>;
  /**
   * Per-message activation gate. `false` skips the event entirely —
   * including the spine publish, because a disabled stage must not emit
   * a half-resolved spine that downstream stages would treat as
   * authoritative.
   */
  readonly isEnabled?: (projectId: string, environment: string) => Promise<boolean> | boolean;
}

export function createRuntime(deps: IdentityStageRuntimeDeps): IdentityStageRuntime {
  const isolatedProjects = deps.isolatedProjects ?? [];

  const handler: TransportMessageHandler = async (payload) => {
    // Tombstones and bodiless messages are skipped, not failed: nothing
    // to resolve, and throwing would rewind the partition on a message
    // that will never decode.
    const value = payload.message.value;
    if (value === null) return;
    const raw = decodeEvent(value) as Record<string, unknown>;

    if (deps.isEnabled !== undefined) {
      const enabled = await deps.isEnabled(
        String(raw["project_id"] ?? ""),
        String(raw["environment"] ?? ""),
      );
      if (!enabled) return;
    }

    await handleEvent(deps, raw);
  };

  let started = false;
  return {
    handler,
    async start(): Promise<void> {
      if (started) return;
      started = true;
      const families = consumerFamiliesFor(STREAM_FAMILY_RAW_EVENTS, isolatedProjects);
      await deps.consumer.subscribe({ families: [...families] });
      deps.logger.info(
        { component: "sync-identity.runtime", families, isolated_projects: isolatedProjects },
        "identity stage subscribed to raw.events",
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
