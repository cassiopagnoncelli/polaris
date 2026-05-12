/**
 * Partition-key generation for canonical Polaris topics.
 *
 * Per `docs/architecture/03-redpanda-topics.md`:
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
 */

/**
 * Minimal envelope shape required to compute the default partition key.
 *
 * The shape mirrors the canonical envelope but is declared structurally so
 * the helper does not need to import `@polaris/shared-schemas` (this package
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
