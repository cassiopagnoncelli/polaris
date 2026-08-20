/**
 * Partition-key generation and partition assignment for canonical Polaris
 * streams.
 *
 * Per `docs/architecture/03-rabbitmq-streams.md`:
 *
 *   project_id + ":" + environment + ":" + best_available_identity
 *
 * Identity fallback order (first non-empty value wins):
 *
 *   1. customer_id
 *   2. anonymous_id
 *   3. session_id
 *   4. event_id
 *
 * The fallback preserves useful per-identity ordering when an identity is
 * available, and falls back to `event_id` so anonymous/backend events still
 * distribute reasonably across partitions.
 *
 * Kafka hashed the key to a partition inside the client library. RabbitMQ
 * super streams put that decision in the publisher's hands: the routing key
 * *is* the partition index, so `partitionForKey` below owns the hash. The
 * function is deliberately boring and self-contained — its output is a wire
 * contract (change it and per-identity ordering breaks across a rolling
 * deploy, exactly like changing a Kafka partitioner would).
 */

/**
 * Minimal envelope shape required to compute the default partition key.
 *
 * The shape mirrors the canonical envelope but is declared structurally so
 * the helper does not need to import `@polaris/spec` (this package
 * stays pure and is consumed by SDK-adjacent code paths).
 */
export interface PartitionKeyInput {
  readonly project_id: string;
  readonly environment: string;
  readonly identity: PartitionKeyIdentity;
  readonly event_id: string;
}

/**
 * Identity layer accepted by the partition-key helper. Every field is
 * optional; nullable values are treated as missing.
 */
export interface PartitionKeyIdentity {
  readonly customer_id?: string | null | undefined;
  readonly anonymous_id?: string | null | undefined;
  readonly session_id?: string | null | undefined;
  readonly device_id?: string | null | undefined;
}

/** Identifier the helper actually chose, useful for metrics/diagnostics. */
export type PartitionKeyIdentitySource = "customer_id" | "anonymous_id" | "session_id" | "event_id";

/**
 * Compute the default partition key for `raw.events` and other canonical
 * topics that share its partitioning rule.
 *
 * Throws a `RangeError` when `project_id`, `environment`, or `event_id` are
 * empty: these are required for any valid event and a missing value would
 * silently route the message to an unrelated partition.
 */
export function buildRawEventsPartitionKey(input: PartitionKeyInput): string {
  return resolveRawEventsPartitionKey(input).key;
}

/**
 * Same as `buildRawEventsPartitionKey` but also returns the identity source
 * that ended up being used. Useful for emitting metrics so operators can
 * detect partition skew caused by frequent fallbacks.
 */
export function resolveRawEventsPartitionKey(input: PartitionKeyInput): {
  readonly key: string;
  readonly identity: string;
  readonly source: PartitionKeyIdentitySource;
} {
  const projectId = requireField(input.project_id, "project_id");
  const environment = requireField(input.environment, "environment");
  const eventId = requireField(input.event_id, "event_id");

  const resolved = resolveIdentity(input.identity, eventId);
  return {
    key: `${projectId}:${environment}:${resolved.value}`,
    identity: resolved.value,
    source: resolved.source,
  };
}

// ---------------------------------------------------------------------
// Profile-keyed partitioning (the spine).
//
// `identified.events` and `resolved.events` partition on the RESOLVED
// person rather than on whichever identifier the producer happened to
// send. That is strictly stronger than the raw rule: once the identity
// stage has stamped a `profile_id`, every event for a person hashes to one
// partition even as that person moves from anonymous to known, so the
// sessionizer, the attribution engine and every destination consumer
// inherit per-person ordering for free.
//
// This is a SEPARATE builder, not a new branch inside
// `resolveIdentity`. `buildRawEventsPartitionKey`'s fallback chain is a
// wire contract: `raw.events` is partitioned by it today, and inserting
// `profile_id` at its head would silently re-partition that stream
// mid-deploy — the exact failure `docs/architecture/03-rabbitmq-streams.md`
// warns about, since two instances disagreeing about the mapping breaks
// per-identity ordering. Keeping them apart means the raw rule is
// provably untouched (there is a regression test asserting it).
//
// See `docs/implementation/pipeline-redesign-plan.md` §2.2.
// ---------------------------------------------------------------------

/** Minimal shape required to compute a spine partition key. */
export interface ProfilePartitionKeyInput {
  readonly project_id: string;
  readonly environment: string;
  /**
   * Resolved profile, or `null` for an event the identity stage could not
   * resolve (no strong identifiers). Such events are stamped
   * `profile: null` and continue down the spine — they are never dropped.
   */
  readonly profile_id: string | null | undefined;
  readonly event_id: string;
}

/** Which value the spine key ended up built from. */
export type ProfilePartitionKeySource = "profile_id" | "event_id";

/**
 * Compute the partition key for `identified.events` / `resolved.events`.
 *
 * Falls back to `event_id` when there is no profile, which is the correct
 * degenerate case rather than a compromise: with no person to order
 * against there is no ordering to preserve, and spreading unresolvable
 * events across partitions keeps them from piling onto partition 0.
 */
export function buildProfilePartitionKey(input: ProfilePartitionKeyInput): string {
  return resolveProfilePartitionKey(input).key;
}

/**
 * Same as `buildProfilePartitionKey` but also reports which source was
 * used, so a processor can emit a metric on how often it is partitioning
 * unresolved traffic — a rising `event_id` share means identity resolution
 * is degrading, and per-person ordering downstream degrades with it.
 */
export function resolveProfilePartitionKey(input: ProfilePartitionKeyInput): {
  readonly key: string;
  readonly identity: string;
  readonly source: ProfilePartitionKeySource;
} {
  const projectId = requireField(input.project_id, "project_id");
  const environment = requireField(input.environment, "environment");
  const eventId = requireField(input.event_id, "event_id");

  const profileId = nonEmpty(input.profile_id);
  const resolved =
    profileId !== undefined
      ? { value: profileId, source: "profile_id" as const }
      : { value: eventId, source: "event_id" as const };

  return {
    key: `${projectId}:${environment}:${resolved.value}`,
    identity: resolved.value,
    source: resolved.source,
  };
}

/**
 * Map a partition key to a partition index.
 *
 * Uses 32-bit FNV-1a: stable across processes and Node versions, no
 * dependency, and well-distributed for the `project:env:identity` shapes
 * Polaris produces. The result is the routing key used against the super
 * stream exchange.
 *
 * A `null`/empty key (a message with no ordering requirement) lands on
 * partition 0 rather than throwing: callers that care about distribution
 * always pass a key, and silently dropping a keyless message would be
 * worse than concentrating it.
 */
export function partitionForKey(key: string | null | undefined, partitions: number): number {
  if (!Number.isInteger(partitions) || partitions < 1) {
    throw new RangeError(
      `partitionForKey: partitions must be a positive integer, got ${String(partitions)}`,
    );
  }
  if (partitions === 1) return 0;
  if (key === undefined || key === null || key.length === 0) return 0;
  return fnv1a32(key) % partitions;
}

/** 32-bit FNV-1a over the UTF-8 bytes of `value`. */
function fnv1a32(value: string): number {
  const bytes = Buffer.from(value, "utf8");
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    // hash * 16777619, kept in uint32 via Math.imul + >>> 0.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function resolveIdentity(
  identity: PartitionKeyIdentity,
  eventId: string,
): { readonly value: string; readonly source: PartitionKeyIdentitySource } {
  const customer = nonEmpty(identity.customer_id);
  if (customer !== undefined) return { value: customer, source: "customer_id" };
  const anonymous = nonEmpty(identity.anonymous_id);
  if (anonymous !== undefined) return { value: anonymous, source: "anonymous_id" };
  const session = nonEmpty(identity.session_id);
  if (session !== undefined) return { value: session, source: "session_id" };
  return { value: eventId, source: "event_id" };
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value.length === 0) return undefined;
  return value;
}

function requireField(value: string, name: string): string {
  if (value === undefined || value === null || value.length === 0) {
    throw new RangeError(`partition key: required envelope field "${name}" is empty`);
  }
  return value;
}
