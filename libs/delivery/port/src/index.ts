/**
 * `@polaris/delivery-port` — the `destination.port` contract.
 *
 * Imported by every connector under `connectors/destinations/` and by the
 * units that bind one to a deployment. See `connectors/README.md` for the
 * registry rule and the add-a-vendor walk-through.
 */

export {
  type DeliveryMode,
  type DestinationConnector,
  defineDestinationConnector,
  toDestinationDescriptor,
} from "./connector.js";
export { positiveIntSchema } from "./project-config.js";
