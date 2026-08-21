/**
 * `destination.port` — the contract every destination connector implements.
 *
 * ADR-0007 splits the vendor-facing edge in two. A CONNECTOR
 * (`connectors/destinations/<vendor>/<version>/`) knows one vendor and
 * nothing else: how a normalized event becomes that vendor's payload, and
 * how that payload reaches that vendor's API. A UNIT
 * (`sync/destinations/<vendor>/<version>/`) knows one deployment: which
 * broker, which database, which port to listen on. This module is the seam,
 * and it exists so the two can be COUNTED separately — five connectors
 * behind five deployables today, and behind however many the operator wants
 * tomorrow, without either side learning that the number changed.
 *
 * That is the whole claim of the registry: `connectors/` records which
 * vendors EXIST; how many processes serve them is an operational decision
 * that leaves no trace in this tree. Adding a vendor is a directory here
 * plus its wiring in `definitions/`, never a new deployable by default.
 *
 * ## What a connector may reach for
 *
 * `libs/spec`, its `libs/delivery` port, and third-party packages — the
 * vendor SDK is the point of the thing. No other `@polaris/*` package, and
 * `scripts/lint-import-direction.mjs` fails the build on one. The rule is
 * not tidiness: a connector that can reach the bus or a Postgres pool is a
 * connector that can only run where those exist, and the registry's value
 * is that a vendor adapter is cheap to add and cheap to move.
 *
 * ## What this port deliberately does NOT do
 *
 * It does not run anything. `DestinationDescriptor` — the shape the shared
 * runtime in `@polaris/delivery-destinations` already binds to — stays the
 * runtime's, and `toDestinationDescriptor` below is the one-way bridge onto
 * it. A port that grew its own execution model would be a second runtime
 * wearing a port's name, and the MAP/DELIVER/RECORD loop is not this card's
 * to re-decide.
 */

import type {
  ConsumerIdentity,
  Deliverer,
  DestinationDescriptor,
  MapperMap,
} from "@polaris/delivery-destinations";
import type {
  IdentityHashingOptions,
  RawIdentityInput,
  RequiredConsent,
} from "@polaris/delivery-normalize";

/**
 * What a connector can be driven FOR.
 *
 *   - `event` — per-event delivery. The canonical `analytics.events` →
 *     normalize → map → deliver path every destination consumer runs today.
 *   - `list`  — membership list operations: add/remove an audience member
 *     against the vendor's list API. ADR-0007 routes
 *     `async/activation/audience-sync/v1` through connectors for exactly
 *     this, and no connector declares it yet.
 *
 * Declared rather than inferred because the two are different vendor
 * surfaces with different credentials and different failure modes, and a
 * caller needs to know which it may ask for BEFORE it asks. A connector
 * that supports only `event` and is handed a list job should be refused by
 * whatever dispatches it, not discovered halfway through a delivery.
 */
export type DeliveryMode = "event" | "list";

/**
 * One vendor adapter, as the rest of the platform sees it.
 *
 * `Payload` is the vendor's wire shape; `Options` is whatever the deliverer
 * has to be constructed WITH — a fetch implementation, a timeout, a host
 * override. Options are the deployment's to supply, which is why `deliver`
 * is a factory rather than a function: the connector knows the vendor's
 * protocol, the unit knows the deployment's numbers, and neither is
 * entitled to the other's half.
 */
export interface DestinationConnector<Payload, Options> {
  /**
   * The registry key — the connector's own directory name under
   * `connectors/destinations/`.
   *
   * NOT `identity.vendor`, and webhook-sink is why: its vendor is `webhook`
   * (webhooks belong to no vendor) while it is registered, queued and
   * configured as `webhook-sink`. The slug is what an operator types and
   * what `definitions/` refers to; the vendor literal is what gets stamped
   * on a delivery record. They coincide for four of the five and the
   * distinction is load-bearing for the fifth.
   */
  readonly slug: string;
  /** Modes this connector can be driven for. Non-empty. */
  readonly supportedModes: readonly DeliveryMode[];
  /** Static vendor identity and per-stage versions, stamped onto every record. */
  readonly identity: ConsumerIdentity;
  /**
   * The project-config namespace this vendor declares keys under — the
   * slice `polaris config set` validates and the admin panel renders.
   */
  readonly projectConfigNamespace: string;
  /**
   * The MAP stage: canonical event name → the mapper that builds this
   * vendor's payload.
   *
   * A map rather than a single `map(event)` function because the runtime's
   * behaviour is keyed on the LOOKUP: an event with no entry becomes a
   * `mapped_failed` record carrying "no mapper registered", which is how a
   * vendor fails loudly on an event nobody mapped. A single function would
   * have to invent that miss itself, and every vendor would invent it
   * differently.
   */
  readonly map: MapperMap<Payload>;
  /**
   * The DELIVER stage, bound to the deployment's options.
   *
   * Called once at wiring time, not once per event: the returned
   * `Deliverer` is what the runtime invokes per attempt.
   */
  readonly deliver: (options: Options) => Deliverer<Payload>;
  /** Consent this vendor requires before an event may be sent to it. */
  readonly requiredConsent: RequiredConsent;
  /** Per-vendor identity hashing toggles. Omitted means hash everything. */
  readonly identityHashing?: IdentityHashingOptions;
  /** Optional rescue of email/phone that a producer put in `properties`. */
  readonly identityFromProperties?: (
    properties: Readonly<Record<string, unknown>>,
  ) => Pick<RawIdentityInput, "email" | "phone"> | undefined;
}

/** A connector's slug: lowercase, digits, and single inner hyphens. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Declare a connector: validate what the type system cannot, then freeze.
 *
 * The three checks below are the ones a typo passes today. A slug is a
 * directory name, a URL segment and a config namespace all at once, so
 * `Meta_CAPI` typechecks and then fails somewhere far from here; an empty
 * `supportedModes` reads as "supports nothing" to a dispatcher and as
 * "nobody filled this in" to a reader, and the two want opposite handling.
 *
 * Freezing is not defensive style — the connector is a module-level
 * singleton shared by every delivery in the process, and a mutable one is a
 * cross-tenant channel.
 */
export function defineDestinationConnector<Payload, Options>(
  connector: DestinationConnector<Payload, Options>,
): DestinationConnector<Payload, Options> {
  if (!SLUG_PATTERN.test(connector.slug)) {
    throw new Error(
      `destination connector slug must be lowercase kebab-case, got "${connector.slug}"`,
    );
  }
  if (connector.supportedModes.length === 0) {
    throw new Error(`destination connector "${connector.slug}" declares no supported modes`);
  }
  const duplicate = connector.supportedModes.find(
    (mode, index) => connector.supportedModes.indexOf(mode) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(
      `destination connector "${connector.slug}" declares mode "${duplicate}" more than once`,
    );
  }
  return Object.freeze({
    ...connector,
    supportedModes: Object.freeze([...connector.supportedModes]),
  });
}

/**
 * Bind a connector to the shared destination runtime.
 *
 * The bridge is one-way and deliberately lossy: `slug`, `supportedModes`
 * and `projectConfigNamespace` do not appear in the descriptor because the
 * runtime has never needed them — it is handed one vendor and told to run
 * it. They are the REGISTRY's fields, read by whatever chooses a connector,
 * and pushing them through the descriptor would put the registry inside the
 * loop that runs one entry from it.
 */
export function toDestinationDescriptor<Payload, Options>(
  connector: DestinationConnector<Payload, Options>,
  options: Options,
): DestinationDescriptor<Payload> {
  return {
    identity: connector.identity,
    mappers: connector.map,
    deliverer: connector.deliver(options),
    requiredConsent: connector.requiredConsent,
    ...(connector.identityHashing === undefined
      ? {}
      : { identityHashing: connector.identityHashing }),
    ...(connector.identityFromProperties === undefined
      ? {}
      : { identityFromProperties: connector.identityFromProperties }),
  };
}
