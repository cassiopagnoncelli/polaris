/**
 * Local type declarations for identity-resolver v1.
 *
 * The processor reads the canonical envelope structurally — it does NOT
 * re-validate the inbound payload through `@polaris/shared-schemas`'s
 * envelope Zod schema. The ingester is authoritative for that, and
 * re-running the full validator on every consumed message would
 * double-validate the hot path (same trade-off as the analytics-projector
 * — see `processors/analytics-projector/v1/src/runtime.ts`).
 *
 * The structural shapes here are narrow enough to keep TypeScript honest
 * inside the transform and the runtime without pulling
 * `@polaris/shared-schemas` into the public surface of this package.
 */

/**
 * Identity layer shape the resolver reads from. Matches the canonical
 * envelope's `identity` block (`anonymous_id`, `session_id`, `customer_id`,
 * `device_id` — all nullable). v1 only uses `anonymous_id` and
 * `customer_id`; the rest are accepted for forward compatibility.
 */
export interface RawEventIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
  readonly device_id: string | null;
}

/** Source layer accepted by the resolver (passthrough; never inspected). */
export interface RawEventSource {
  readonly type: string;
  readonly id: string;
  readonly sdk?: string | null | undefined;
  readonly sdk_version?: string | null | undefined;
}

/**
 * Inbound canonical envelope shape. Mirrors the canonical envelope from
 * `01-event-contract.md` with `properties` / `context` / `consent` /
 * `privacy` kept as `Record<string, unknown>` because the resolver does
 * not introspect them.
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
  readonly context: Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;
}
