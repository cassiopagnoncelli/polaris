/**
 * Webhook-sink v1 destination descriptor.
 *
 * Per `docs/architecture/06-destinations.md`, every destination consumer
 * declares a `DestinationDescriptor` that the runtime composes into the
 * MAP + DELIVER + RECORD pipeline.
 *
 * The descriptor here is intentionally minimal — webhook-sink is the
 * canonical "thin" exemplar:
 *
 *   - identity            pinned vendor + per-stage versions
 *   - mappers             every canonical event maps through the same
 *                         passthrough mapper (the receiver decides what
 *                         to read from `event`); exposed as a `Proxy` so
 *                         the runtime's `descriptor.mappers[name]` lookup
 *                         resolves for any event name without us
 *                         enumerating the platform catalog.
 *   - deliverer           HTTP POST with optional HMAC-SHA256 signing,
 *                         bound to the per-service request timeout.
 *   - requiredConsent     none — receivers decide.
 *   - identityHashing     hash both email + phone.
 *
 * Future vendor consumers (Meta CAPI, GA4, TikTok, Braze) clone the shape
 * but replace the passthrough mapper with vendor-specific mappers (one
 * per canonical event they support), and tune `requiredConsent` to the
 * vendor's policy.
 */

import type {
  IdentityHashingOptions,
  RequiredConsent,
} from "@polaris/shared-destination-normalize";
import type { DestinationDescriptor, Mapper, MapperMap } from "@polaris/shared-destinations";

import { type BuildDelivererOptions, buildWebhookDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { webhookPassthroughMapper } from "./mapper.js";
import type { WebhookPayload } from "./types.js";

/** Receiver-decided consent — webhooks gate nothing by default. */
const REQUIRED_CONSENT: RequiredConsent = Object.freeze({});

/**
 * Hash both email and phone before exposing them to receivers. The
 * normalize layer keeps both raw + hashed forms on the prepared identity
 * regardless of these flags; the toggles control whether the hashed slot
 * is populated. Webhook receivers may consume either depending on their
 * downstream contract.
 */
const IDENTITY_HASHING: IdentityHashingOptions = Object.freeze({
  email: true,
  phone: true,
});

/**
 * `MapperMap` proxy that returns the passthrough mapper for any event name.
 * The runtime's lookup is `descriptor.mappers[normalized.event]`; trapping
 * `get` returns the same mapper for every event so we don't have to
 * enumerate the canonical catalog. `Reflect.ownKeys` returns an empty list
 * so tests / introspection callers don't see a hallucinated catalog.
 *
 * `has(_, prop)` returns `true` for all string keys so the runtime's
 * "missing mapper" branch is unreachable for webhook-sink — the receiver
 * decides what to accept, not Polaris.
 */
function buildPassthroughMapperMap(): MapperMap<WebhookPayload> {
  const map = new Proxy<MapperMap<WebhookPayload>>({} as MapperMap<WebhookPayload>, {
    get(_target, prop): Mapper<WebhookPayload> | undefined {
      if (typeof prop !== "string") return undefined;
      return webhookPassthroughMapper;
    },
    has(_target, prop): boolean {
      return typeof prop === "string";
    },
    ownKeys(): ArrayLike<string | symbol> {
      return [];
    },
    getOwnPropertyDescriptor(): PropertyDescriptor | undefined {
      return undefined;
    },
  });
  return map;
}

/** Options accepted by `createWebhookSinkDescriptor`. Forwarded to the deliverer. */
export interface CreateWebhookSinkDescriptorOptions extends BuildDelivererOptions {}

/**
 * Build the `DestinationDescriptor` for webhook-sink v1. The factory is
 * pure: tests build a fresh descriptor per case so injected `fetch` /
 * `now` slots don't leak across runs.
 */
export function createWebhookSinkDescriptor(
  options: CreateWebhookSinkDescriptorOptions,
): DestinationDescriptor<WebhookPayload> {
  return {
    identity: CONSUMER_IDENTITY,
    mappers: buildPassthroughMapperMap(),
    deliverer: buildWebhookDeliverer(options),
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  };
}
