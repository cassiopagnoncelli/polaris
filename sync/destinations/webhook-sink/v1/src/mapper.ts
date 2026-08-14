/**
 * Webhook-sink v1 mapper.
 *
 * The webhook-sink is intentionally event-agnostic — receivers consume the
 * full normalized event under `event` and pick the fields they care about.
 * The mapper therefore does not branch by canonical event name: it simply
 * wraps every normalized envelope into the `WebhookPayload` shape with the
 * Polaris delivery envelope around it.
 *
 * Per `docs/architecture/06-destinations.md`, this is the MAP stage of the
 * destination pipeline. It is pure: no I/O, no time reads, no PII reach
 * (the `MapperContext` doesn't carry the raw envelope). The runtime
 * passes the result to the deliverer with the resolved secret.
 *
 * One mapper instance is registered for every canonical event name we
 * recognise; missing entries land as `mapped_failed` records by the
 * runtime. Webhook-sink supports every event by registering a single
 * passthrough mapper under the `__webhook_passthrough__` sentinel that
 * the descriptor uses via a Proxy.
 */

import type { Mapper, MapperContext, MapperResult } from "@polaris/shared-destinations";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import type { WebhookPayload } from "./types.js";

/**
 * Build the canonical `WebhookPayload` for one normalized event.
 *
 * The shape mirrors the contract declared in `./types.ts`:
 *
 *   - `version: 1`            — wire format pin
 *   - `delivery.delivery_key` — runtime-supplied, set on the wire by the
 *                               deliverer (this mapper leaves the slot blank
 *                               and the deliverer fills it from
 *                               `DelivererContext.delivery_key`); we hold
 *                               an empty placeholder here only so the
 *                               mapper's output is a complete `WebhookPayload`
 *                               shape that tests can assert against without
 *                               special-casing the deliverer.
 *   - `delivery.attempt`      — runtime-supplied, same pattern.
 *   - `delivery.sent_at`      — runtime-supplied, same pattern.
 *   - `delivery.consumer.*`   — pinned vendor + per-stage versions.
 *   - `event`                 — the normalized event, byte-for-byte.
 *
 * The deliverer overwrites the `delivery_key` / `attempt` / `sent_at`
 * slots before POSTing so the receiver sees authoritative values from the
 * runtime (not stale placeholders from the mapper).
 */
export const webhookPassthroughMapper: Mapper<WebhookPayload> = (
  context: MapperContext,
): MapperResult<WebhookPayload> => {
  const { normalized } = context;
  const payload: WebhookPayload = {
    version: 1,
    delivery: {
      // Placeholders — the deliverer overwrites these per attempt.
      delivery_key: "",
      attempt: 0,
      sent_at: "",
      consumer: {
        vendor: CONSUMER_IDENTITY.vendor,
        consumer_version: CONSUMER_IDENTITY.consumerVersion,
        mapper_version: CONSUMER_IDENTITY.mapperVersion,
        deliverer_version: CONSUMER_IDENTITY.delivererVersion,
      },
    },
    event: normalized,
  };
  return { kind: "mapped", payload, dedupe_key: normalized.event_id };
};

/**
 * Overwrite the runtime-supplied slots on the payload, returning a new
 * object. Pure; the input is not mutated. The deliverer calls this so
 * the wire payload carries authoritative `delivery.*` fields rather than
 * the mapper's placeholders.
 */
export function stampDelivery(
  payload: WebhookPayload,
  delivery: { readonly delivery_key: string; readonly attempt: number; readonly sent_at: string },
): WebhookPayload {
  return {
    ...payload,
    delivery: {
      ...payload.delivery,
      delivery_key: delivery.delivery_key,
      attempt: delivery.attempt,
      sent_at: delivery.sent_at,
    },
  };
}
