import { checkoutStartedV1PropertiesSchema } from "../events/checkout/started.v1.js";
import { pageViewedV1PropertiesSchema } from "../events/page/viewed.v1.js";
import { pageViewedV2PropertiesSchema } from "../events/page/viewed.v2.js";
import type { SchemaBinding } from "./types.js";

/**
 * The set of (event, schema_version) → Zod schema bindings shipped with
 * this package. The ingester combines this list with the YAML lifecycle
 * data from `catalog/events/**` to build the runtime catalog.
 *
 * Adding a new event version is two steps:
 *   1. Add `events/<domain>/<event>.v<N>.ts` with the Zod schema.
 *   2. Register the binding here.
 *
 * The YAML file under `catalog/events/<domain>/<event>.v<N>.yaml` then
 * provides the lifecycle metadata. The loader rejects mismatches
 * (binding without YAML, or YAML without binding).
 */
export const defaultSchemaBindings: readonly SchemaBinding[] = [
  {
    event: "page.viewed",
    schema_version: 1,
    propertiesSchema: pageViewedV1PropertiesSchema,
  },
  {
    event: "page.viewed",
    schema_version: 2,
    propertiesSchema: pageViewedV2PropertiesSchema,
  },
  {
    event: "checkout.started",
    schema_version: 1,
    propertiesSchema: checkoutStartedV1PropertiesSchema,
  },
];
