/**
 * Canonical Redpanda topic constants and topic-family identifiers.
 *
 * Per `docs/architecture/03-redpanda-topics.md`, Polaris uses shared canonical
 * topics by default. A project may graduate to a dedicated topic when one of
 * the documented isolation triggers fires — at that point the concrete topic
 * name becomes `<family>.<project_id>`. Producer and consumer code references
 * the logical **family**; the resolver in `topic-family.ts` returns the
 * concrete topic name from PostgreSQL-backed isolation state.
 *
 * Topic constants are intentionally string literals (not enums) so they
 * survive ESM tree-shaking and `import type` boundaries cleanly.
 */

/**
 * Logical topic families that have a shared default and may have per-project
 * dedicated topics. These are the only families that flow through the
 * isolation resolver.
 */
export const TOPIC_FAMILY_RAW_EVENTS = "raw.events" as const;
export const TOPIC_FAMILY_IDENTITY_EVENTS = "identity.events" as const;
export const TOPIC_FAMILY_ENRICHED_EVENTS = "enriched.events" as const;
export const TOPIC_FAMILY_ATTRIBUTION_EVENTS = "attribution.events" as const;
export const TOPIC_FAMILY_ANALYTICS_EVENTS = "analytics.events" as const;

/**
 * Optional SDK diagnostics topic. Operators opt projects in per environment.
 * Diagnostics events use the canonical envelope but always carry a
 * `polaris.diagnostics.*` event name. Not consumed by processors or
 * destinations. Short retention (suggested 7 days).
 */
export const TOPIC_DIAGNOSTICS_EVENTS = "polaris.diagnostics.events" as const;

/**
 * The set of canonical topic families that support project isolation. The
 * resolver consults PostgreSQL to determine whether a given (family,
 * project_id) pair has an active dedicated topic.
 */
export const CANONICAL_TOPIC_FAMILIES = [
  TOPIC_FAMILY_RAW_EVENTS,
  TOPIC_FAMILY_IDENTITY_EVENTS,
  TOPIC_FAMILY_ENRICHED_EVENTS,
  TOPIC_FAMILY_ATTRIBUTION_EVENTS,
  TOPIC_FAMILY_ANALYTICS_EVENTS,
] as const;

/** Canonical topic-family literal type. */
export type CanonicalTopicFamily = (typeof CANONICAL_TOPIC_FAMILIES)[number];

/** Type-narrowing guard for canonical topic families. */
export function isCanonicalTopicFamily(value: string): value is CanonicalTopicFamily {
  return (CANONICAL_TOPIC_FAMILIES as ReadonlyArray<string>).includes(value);
}

/**
 * Build the concrete dedicated topic name for a project. Used by the resolver
 * when a project has an active isolation record. The shape is intentionally
 * stable: `<family>.<project_id>`.
 *
 * Validation of `project_id` content (length, charset, reserved values) is
 * the caller's responsibility — this helper assumes the value has already
 * been validated by the catalog or control plane.
 */
export function dedicatedTopicName(family: CanonicalTopicFamily, projectId: string): string {
  if (projectId.length === 0) {
    throw new Error("dedicatedTopicName: project_id must be a non-empty string");
  }
  return `${family}.${projectId}`;
}

/**
 * Standard retry / DLQ topic naming convention.
 *
 * Per `03-redpanda-topics.md`, processors and consumers own their retry and
 * DLQ topics. Examples in the doc: `geoip-enricher.retry`, `meta-capi.dlq`.
 * The component identifier is the processor or consumer's directory name
 * (e.g. `geoip-enricher`, `identity-resolver`, `meta-capi`).
 */
export function retryTopicName(component: string): string {
  if (component.length === 0) {
    throw new Error("retryTopicName: component must be a non-empty string");
  }
  return `${component}.retry`;
}

export function dlqTopicName(component: string): string {
  if (component.length === 0) {
    throw new Error("dlqTopicName: component must be a non-empty string");
  }
  return `${component}.dlq`;
}
