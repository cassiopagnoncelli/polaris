/**
 * Per-source CORS allow-list contract.
 *
 * The ingester refuses a browser request whose `Origin` header is not on the
 * per-source allow-list. Server-to-server callers do not send an `Origin`
 * header and are not subject to the check.
 *
 * The repository contract is intentionally narrow — one method, one input
 * tuple — so the live PostgreSQL repository and the in-memory test fake
 * implement the same surface. The cache wraps either implementation.
 *
 * @see docs/architecture/11-production-readiness.md "Security Hardening"
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Responsibilities"
 */

export interface OriginLookupInput {
  /** Project the source belongs to. Stamped from the API key. */
  readonly projectId: string;
  /** Source id the API key authenticates. */
  readonly sourceId: string;
  /** Environment the source is running in. */
  readonly environment: string;
}

/**
 * Result of an allow-list lookup. Always a stable, immutable string array;
 * never `undefined` so callers can branch on `length === 0` (deny by
 * default) without a guard for the "row missing" case.
 */
export type AllowedOriginsResult = readonly string[];

/**
 * Lookup contract used by the origin guard layer.
 */
export interface AllowedOriginsRepository {
  /**
   * Return the allow-listed origins for a `(project_id, source_id, environment)`
   * triple. Returns an empty array when no rows exist (deny-by-default).
   */
  findFor(input: OriginLookupInput): Promise<AllowedOriginsResult>;
}
