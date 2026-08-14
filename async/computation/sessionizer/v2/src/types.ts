/**
 * Local type declarations for sessionizer v2.
 *
 * The processor reads the canonical envelope structurally — it does NOT
 * re-validate the inbound payload through `@polaris/shared-schemas`'s
 * envelope Zod schema. The ingester is authoritative for that, and
 * re-running the full validator on every consumed message would
 * double-validate the hot path (same trade-off as the analytics-projector
 * and identity-resolver runtimes).
 *
 * The structural shapes here are narrow enough to keep TypeScript honest
 * inside the transform and the runtime without pulling
 * `@polaris/shared-schemas` into the public surface of this package.
 */

/**
 * Identity layer shape the sessionizer reads from. Matches the canonical
 * envelope's `identity` block. v1 uses `customer_id`, `anonymous_id`, and
 * `session_id`; `device_id` is accepted for forward compatibility but
 * unused.
 */
export interface RawEventIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
  readonly device_id: string | null;
}

/** Source layer accepted by the sessionizer (passthrough; never inspected). */
export interface RawEventSource {
  readonly type: string;
  readonly id: string;
  readonly sdk?: string | null | undefined;
  readonly sdk_version?: string | null | undefined;
}

/**
 * Inbound canonical envelope shape. Mirrors the canonical envelope from
 * `01-event-contract.md` with `properties` / `context` / `consent` /
 * `privacy` kept as `Record<string, unknown>` because the sessionizer
 * does not introspect them.
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
  /**
   * Stamped by the identity stage, carried through by enrichment.
   * `null` for an event that could not be resolved to a person — v2
   * drops those, so this is the field that decides whether an event is
   * sessionizable at all.
   */
  readonly profile?: { readonly profile_id?: string | null } | null | undefined;
  readonly context: Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;
}
