/**
 * Local type declarations for attribution-engine v1.
 *
 * The processor reads the canonical envelope structurally — it does NOT
 * re-validate the inbound payload through `@polaris/shared-schemas`'s
 * envelope Zod schema. The ingester is authoritative for that, and
 * re-running the full validator on every consumed message would
 * double-validate the hot path (same trade-off as the analytics-projector,
 * identity-resolver, and sessionizer runtimes).
 *
 * Structural shapes here are narrow enough to keep TypeScript honest
 * inside the transform and the runtime without pulling
 * `@polaris/shared-schemas` into the public surface of this package.
 */

/**
 * Identity layer the attribution engine reads from. Matches the canonical
 * envelope's `identity` block. v1 uses `customer_id`, `anonymous_id`, and
 * `session_id`; `device_id` is accepted for forward compatibility but
 * unused.
 */
export interface AttributionEventIdentity {
  readonly anonymous_id: string | null;
  readonly session_id: string | null;
  readonly customer_id: string | null;
  readonly device_id: string | null;
}

/**
 * Source layer accepted by the attribution engine (passthrough; never
 * inspected for attribution rules).
 */
export interface AttributionEventSource {
  readonly type: string;
  readonly id: string;
  readonly sdk?: string | null | undefined;
  readonly sdk_version?: string | null | undefined;
}

/**
 * Campaign sub-context the engine reads. Mirrors `envelope/primitives.ts`
 * `campaignContextSchema` but with every field expressed as
 * `string | null | undefined` to tolerate producers that omit fields
 * versus producers that set them to null. The transform normalises both
 * to `null` before applying detection rules.
 */
export interface AttributionEventCampaign {
  readonly source?: string | null | undefined;
  readonly medium?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly term?: string | null | undefined;
  readonly content?: string | null | undefined;
  readonly click_id?: string | null | undefined;
}

/**
 * Canonical context layer accepted by the engine. The engine only reads
 * `campaign`; other fields are kept as `unknown` (or narrowly typed where
 * the Kafka-side decoder produces them) so the runtime can pass the
 * envelope around without losing field-level traceability in logs.
 */
export interface AttributionEventContext {
  readonly ip?: string | null | undefined;
  readonly user_agent?: string | null | undefined;
  readonly locale?: string | null | undefined;
  readonly page?: Readonly<Record<string, unknown>> | null | undefined;
  readonly campaign?: AttributionEventCampaign | null | undefined;
}

/**
 * Inbound canonical envelope shape. Mirrors the canonical envelope from
 * `01-event-contract.md`. The engine inspects only the platform-stamped
 * fields plus `identity` and `context.campaign`; `properties`, `consent`,
 * and `privacy` are kept as `Record<string, unknown>` because the engine
 * does not introspect them.
 *
 * The shape accepts both raw.events envelopes and analytics.events
 * envelopes (which carry the projector's processor stamp). The processor
 * stamp is not inspected; the engine only needs the envelope identity
 * and context layers.
 */
export interface AnalyticsEventEnvelope {
  readonly event_id: string;
  readonly event: string;
  readonly schema_version: number;
  readonly project_id: string;
  readonly environment: string;
  readonly occurred_at: string;
  readonly ingested_at: string;
  readonly source: AttributionEventSource;
  readonly identity: AttributionEventIdentity;
  /**
   * Stamped by the identity stage, carried through by enrichment.
   * `null` for an event that could not be resolved to a person — v3
   * drops those, so this decides whether an event can join a chain.
   */
  readonly profile?: { readonly profile_id?: string | null } | null | undefined;
  readonly context: AttributionEventContext;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly consent?: Readonly<Record<string, unknown>> | undefined;
  readonly privacy?: Readonly<Record<string, unknown>> | undefined;
}
