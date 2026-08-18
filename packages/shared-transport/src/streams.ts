/**
 * Canonical stream families and RabbitMQ naming conventions.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md`, Polaris uses shared
 * canonical streams by default. A project may graduate to a dedicated
 * stream when one of the documented isolation triggers fires — at that
 * point the concrete family name becomes `<family>.<project_id>`. Producer
 * and consumer code references the logical **family**; the resolver in
 * `stream-family.ts` returns the concrete family name from
 * PostgreSQL-backed isolation state.
 *
 * Every family is a RabbitMQ **super stream**: a direct exchange named
 * after the family, fronting `N` partition streams named
 * `<family>-<partition>` and bound with the partition index as the routing
 * key. This is byte-for-byte the layout `rabbitmq-streams add_super_stream`
 * produces, so the management CLI, the native stream protocol client, and
 * this package all agree on names.
 *
 * ```text
 * exchange  raw.events            (direct)
 *   binding "0" -> stream raw.events-0
 *   binding "1" -> stream raw.events-1
 *   binding "2" -> stream raw.events-2
 * ```
 *
 * Unlike Kafka, RabbitMQ does **not** auto-create anything on first
 * publish. Every stream, exchange, and queue below must be declared by
 * `topology.ts` (or `scripts/rabbitmq-provision.mjs`) before traffic
 * flows. Publishing to a missing exchange is a silent drop; consuming from
 * a missing stream is a channel error.
 *
 * Stream constants are intentionally string literals (not enums) so they
 * survive ESM tree-shaking and `import type` boundaries cleanly.
 */

/**
 * Logical stream families that have a shared default and may have
 * per-project dedicated streams. These are the only families that flow
 * through the isolation resolver.
 */
export const STREAM_FAMILY_RAW_EVENTS = "raw.events" as const;
export const STREAM_FAMILY_IDENTITY_EVENTS = "identity.events" as const;
export const STREAM_FAMILY_SESSION_EVENTS = "session.events" as const;
export const STREAM_FAMILY_ATTRIBUTION_EVENTS = "attribution.events" as const;

/**
 * Intermediate family between the two spine stages: the identity stage
 * emits here, the enrichment stage consumes here.
 *
 * Short retention and deliberately NOT a replay anchor. It is fully
 * regenerable — replaying `raw.events` through the identity stage
 * reproduces it — so retaining it for the raw window would cost disk for
 * data that is already recoverable. `raw.events` remains the only stream
 * anyone replays from.
 */
export const STREAM_FAMILY_IDENTIFIED_EVENTS = "identified.events" as const;

/**
 * THE canonical spine. Carries the same `event_id` as the source event,
 * now with the platform-owned `profile` and `enrichment` blocks attached.
 *
 * Everything downstream reads this: destination consumers (stages 4-5),
 * the ClickHouse sink, and the async computation processors. Partitioned
 * by `profile_id`, so per-person ordering holds regardless of which
 * identifier a producer sent.
 */
export const STREAM_FAMILY_RESOLVED_EVENTS = "resolved.events" as const;

/**
 * Profile-plane facts: `profile.updated`, and later `trait.computed` and
 * `audience.entered` / `.exited`.
 *
 * Narrower than the spine (profile changes are far rarer than events) and
 * consumed by the ClickHouse sink, which is what makes trait history exist
 * at all — `profiles.traits` in Postgres holds only the current value.
 */
export const STREAM_FAMILY_PROFILE_EVENTS = "profile.events" as const;

/**
 * Optional SDK diagnostics stream. Operators opt projects in per
 * environment. Diagnostics events use the canonical envelope but always
 * carry a `polaris.diagnostics.*` event name. Not consumed by processors
 * or destinations. Short retention (7 days, see `topology.ts`).
 */
export const STREAM_DIAGNOSTICS_EVENTS = "polaris.diagnostics.events" as const;

/**
 * The schema-governance quarantine.
 *
 * Carries a VIOLATION RECORD, not an envelope — the events on it failed
 * validation by definition, so they have no envelope to carry. Written by
 * the ingester after it has already answered the producer, and read by
 * the ClickHouse sink and nothing else.
 *
 * Deliberately NOT in {@link CANONICAL_STREAM_FAMILIES}: isolation exists
 * so a noisy project cannot starve another's SPINE throughput, and this
 * family has no spine consumer to starve. Adding it would also make every
 * isolated project's quarantine a separate stream for the sink to
 * discover, which is cost with no matching benefit for a diagnostics
 * stream nothing replays. Short retention (7 days, see `topology.ts`) —
 * a governance signal that is a week old is a dashboard entry, not an
 * incident.
 */
export const STREAM_FAMILY_REJECTED_EVENTS = "rejected.events" as const;

/**
 * The set of canonical stream families that support project isolation. The
 * resolver consults PostgreSQL to determine whether a given (family,
 * project_id) pair has an active dedicated stream.
 *
 * `session.events` joined this list with the RabbitMQ migration: under
 * Kafka it was an auto-created topic the sessionizer published to by
 * name, which only worked because Redpanda ran with topic auto-creation.
 * RabbitMQ declares everything up front, so the family is now first-class.
 */
export const CANONICAL_STREAM_FAMILIES = [
  STREAM_FAMILY_RAW_EVENTS,
  STREAM_FAMILY_IDENTIFIED_EVENTS,
  STREAM_FAMILY_RESOLVED_EVENTS,
  STREAM_FAMILY_PROFILE_EVENTS,
  STREAM_FAMILY_IDENTITY_EVENTS,
  STREAM_FAMILY_SESSION_EVENTS,
  STREAM_FAMILY_ATTRIBUTION_EVENTS,
] as const;

/** Canonical stream-family literal type. */
export type CanonicalStreamFamily = (typeof CANONICAL_STREAM_FAMILIES)[number];

/** Type-narrowing guard for canonical stream families. */
export function isCanonicalStreamFamily(value: string): value is CanonicalStreamFamily {
  return (CANONICAL_STREAM_FAMILIES as ReadonlyArray<string>).includes(value);
}

/**
 * Build the concrete dedicated family name for a project. Used by the
 * resolver when a project has an active isolation record. The shape is
 * intentionally stable: `<family>.<project_id>`.
 *
 * Validation of `project_id` content (length, charset, reserved values) is
 * the caller's responsibility — this helper assumes the value has already
 * been validated by the catalog or control plane.
 */
export function dedicatedStreamFamily(family: CanonicalStreamFamily, projectId: string): string {
  if (projectId.length === 0) {
    throw new Error("dedicatedStreamFamily: project_id must be a non-empty string");
  }
  return `${family}.${projectId}`;
}

/**
 * Concrete partition stream name for a family.
 *
 * `partitionStreamName("raw.events", 2)` -> `raw.events-2`.
 */
export function partitionStreamName(family: string, partition: number): string {
  if (family.length === 0) {
    throw new Error("partitionStreamName: family must be a non-empty string");
  }
  if (!Number.isInteger(partition) || partition < 0) {
    throw new Error(
      `partitionStreamName: partition must be a non-negative integer, got ${String(partition)}`,
    );
  }
  return `${family}-${partition}`;
}

/**
 * Every partition stream name for a family, in partition order.
 */
export function partitionStreamNames(family: string, partitions: number): ReadonlyArray<string> {
  if (!Number.isInteger(partitions) || partitions < 1) {
    throw new Error(
      `partitionStreamNames: partitions must be a positive integer, got ${String(partitions)}`,
    );
  }
  return Array.from({ length: partitions }, (_unused, index) => partitionStreamName(family, index));
}

/**
 * Split a concrete partition stream name back into its family and
 * partition index. Returns `undefined` when the name does not carry the
 * `<family>-<partition>` shape (e.g. a retry or DLQ queue).
 */
export function parsePartitionStreamName(
  stream: string,
): { family: string; partition: number } | undefined {
  const separator = stream.lastIndexOf("-");
  if (separator <= 0 || separator === stream.length - 1) return undefined;
  const suffix = stream.slice(separator + 1);
  if (!/^\d+$/.test(suffix)) return undefined;
  return { family: stream.slice(0, separator), partition: Number(suffix) };
}

/**
 * The super-stream exchange name for a family. Identical to the family
 * name — publishers address the exchange, consumers address the partition
 * streams behind it.
 */
export function streamExchangeName(family: string): string {
  return family;
}

/**
 * Retry backoff tiers, in milliseconds.
 *
 * Each tier is its own quorum queue with a queue-level `x-message-ttl`.
 * The obvious alternative — one retry queue with a per-message
 * `expiration` — is wrong for RabbitMQ: TTL expiry is evaluated at the
 * *head* of the queue, so one message with a 30-minute backoff parked at
 * the head holds back every 5-second retry behind it. Fixed tiers make
 * expiry order equal arrival order within a tier, which is the property
 * the backoff schedule actually needs.
 *
 * Attempt N (1-based) uses tier `min(N, tiers.length) - 1`.
 */
export const RETRY_BACKOFF_TIERS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

/** Backoff tier for a 1-based attempt number. */
export function retryTierForAttempt(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), RETRY_BACKOFF_TIERS_MS.length) - 1;
  const tier = RETRY_BACKOFF_TIERS_MS[index];
  if (tier === undefined) {
    throw new Error(`retryTierForAttempt: no tier for attempt ${String(attempt)}`);
  }
  return tier;
}

/**
 * Standard retry / redelivery / DLQ queue naming.
 *
 * Under Kafka these were topics the component republished into, with the
 * delay implemented by the consumer sleeping. Under RabbitMQ they are
 * **quorum queues** with a native dead-letter path and the broker owning
 * the delay:
 *
 * ```text
 * <component>.retry.<tier_ms>  quorum, x-message-ttl=<tier>, DLX -> redeliver
 * <component>.redeliver        quorum, consumed alongside the component's streams
 * <component>.dlq              quorum, terminal; drained by CLI tooling
 * ```
 *
 * The component identifier is the processor or consumer's directory name
 * (e.g. `geoip-enricher`, `identity-resolver`, `meta-capi`).
 */
export function retryQueueName(component: string, tierMs: number): string {
  assertComponent(component, "retryQueueName");
  if (!Number.isInteger(tierMs) || tierMs < 1) {
    throw new Error(`retryQueueName: tierMs must be a positive integer, got ${String(tierMs)}`);
  }
  return `${component}.retry.${tierMs}`;
}

/** Every retry-tier queue name for a component, shortest tier first. */
export function retryQueueNames(component: string): ReadonlyArray<string> {
  return RETRY_BACKOFF_TIERS_MS.map((tier) => retryQueueName(component, tier));
}

export function redeliverQueueName(component: string): string {
  assertComponent(component, "redeliverQueueName");
  return `${component}.redeliver`;
}

export function dlqQueueName(component: string): string {
  assertComponent(component, "dlqQueueName");
  return `${component}.dlq`;
}

/**
 * Exchange that routes expired retry messages back to the component's
 * redelivery queue. One per component so a slow retry loop on one
 * component cannot stall another's.
 */
export function retryExchangeName(component: string): string {
  assertComponent(component, "retryExchangeName");
  return `${component}.retry.dlx`;
}

function assertComponent(component: string, fn: string): void {
  if (component.length === 0) {
    throw new Error(`${fn}: component must be a non-empty string`);
  }
}
