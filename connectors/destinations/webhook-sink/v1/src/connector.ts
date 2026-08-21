/**
 * Webhook-sink v1 destination connector.
 *
 * The `destination.port` implementation for the vendor-agnostic webhook
 * receiver, and the canonical "thin" exemplar — the smallest thing that is
 * still a connector:
 *
 *   - identity            pinned vendor + per-stage versions
 *   - map                 every canonical event maps through the same
 *                         passthrough mapper (the receiver decides what
 *                         to read from `event`); exposed as a `Proxy` so
 *                         the runtime's `connector.map[name]` lookup
 *                         resolves for any event name without us
 *                         enumerating the platform catalog.
 *   - deliver             HTTP POST with optional HMAC-SHA256 signing,
 *                         bound to the per-service request timeout.
 *   - requiredConsent     none — receivers decide.
 *   - identityHashing     hash both email + phone.
 *
 * The vendor connectors beside it (Meta CAPI, GA4, TikTok, Braze) clone the
 * shape but replace the passthrough mapper with vendor-specific mappers
 * (one per canonical event they support), and tune `requiredConsent` to the
 * vendor's policy. `connectors/README.md` walks that path end to end.
 *
 * Note the slug: `webhook-sink`, while `identity.vendor` is `webhook`. The
 * registry key is the directory name an operator configures against; the
 * vendor literal is what gets stamped on a delivery record. This is the
 * connector where the two differ, and the port documents why.
 */

import type { DestinationDescriptor, Mapper, MapperMap } from "@polaris/delivery-destinations";
import type { IdentityHashingOptions, RequiredConsent } from "@polaris/delivery-normalize";
import {
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "@polaris/delivery-port";

import { type BuildDelivererOptions, buildWebhookDeliverer } from "./deliverer.js";
import { CONSUMER_IDENTITY } from "./descriptor-identity.js";
import { webhookPassthroughMapper } from "./mapper.js";
import { PROJECT_CONFIG_NAMESPACE } from "./project-config.js";
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

/**
 * The passthrough map, built once.
 *
 * Module-level rather than per-descriptor because the connector is a
 * singleton: the Proxy holds no state, so a fresh one per descriptor was
 * an allocation with nothing to distinguish it.
 */
const MAPPERS: MapperMap<WebhookPayload> = buildPassthroughMapperMap();

/** Options accepted by `createWebhookSinkDescriptor`. Forwarded to the deliverer. */
export interface CreateWebhookSinkDescriptorOptions extends BuildDelivererOptions {}

/**
 * The webhook-sink registry entry.
 *
 * `event` only, and here that is a statement about the receiver rather
 * than about a vendor API: a webhook has no list surface to call.
 */
export const webhookSinkConnector: DestinationConnector<
  WebhookPayload,
  CreateWebhookSinkDescriptorOptions
> = defineDestinationConnector({
  slug: "webhook-sink",
  supportedModes: ["event"],
  identity: CONSUMER_IDENTITY,
  projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
  map: MAPPERS,
  deliver: buildWebhookDeliverer,
  requiredConsent: REQUIRED_CONSENT,
  identityHashing: IDENTITY_HASHING,
});

/** Build the `DestinationDescriptor` the shared runtime binds to. */
export function createWebhookSinkDescriptor(
  options: CreateWebhookSinkDescriptorOptions,
): DestinationDescriptor<WebhookPayload> {
  return toDestinationDescriptor(webhookSinkConnector, options);
}
