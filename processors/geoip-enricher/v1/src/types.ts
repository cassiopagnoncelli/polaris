/**
 * Local type declarations for geoip-enricher v1.
 *
 * The processor reads the canonical envelope structurally — it does NOT
 * re-validate the inbound payload through `@polaris/shared-schemas`'s
 * envelope Zod schema. The ingester is authoritative for that, and
 * re-running the full validator on every consumed message would
 * double-validate the hot path (same trade-off as analytics-projector
 * and identity-resolver).
 *
 * The structural shapes here are narrow enough to keep TypeScript honest
 * inside the transform and the runtime without pulling
 * `@polaris/shared-schemas` into the public surface of this package.
 */

/**
 * Identity layer the enricher passes through unchanged. Matches the
 * canonical envelope's `identity` block.
 */
export interface RawEventIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
  readonly device_id: string | null;
}

/** Source layer accepted by the enricher (never inspected). */
export interface RawEventSource {
  readonly type: string;
  readonly id: string;
  readonly sdk?: string | null | undefined;
  readonly sdk_version?: string | null | undefined;
}

/**
 * Context layer the enricher reads from. v1 only reads `ip`; other
 * fields are accepted for forward compatibility and never inspected.
 *
 * `ip` is intentionally `unknown` so the runtime narrows it through a
 * structural check rather than trusting the inbound payload. A missing
 * or non-string `ip` is treated as "no IP" and the enricher emits a
 * null-geo row with `source = "no_ip"`.
 */
export interface RawEventContext {
  readonly ip?: unknown;
  readonly user_agent?: unknown;
  readonly locale?: unknown;
  readonly page?: unknown;
  readonly campaign?: unknown;
}

/**
 * Inbound canonical envelope shape. Mirrors the canonical envelope from
 * `01-event-contract.md` with `properties` / `consent` / `privacy` kept
 * as `Record<string, unknown>` because the enricher does not introspect
 * them.
 */
export interface RawEventEnvelope {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: RawEventSource;
  readonly identity: RawEventIdentity;
  readonly context: RawEventContext;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;
}
