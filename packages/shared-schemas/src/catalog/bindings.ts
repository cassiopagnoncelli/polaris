import { attributionFirstTouchAssignedV1PropertiesSchema } from "../events/attribution/first_touch_assigned.v1.js";
import { attributionLastTouchAssignedV1PropertiesSchema } from "../events/attribution/last_touch_assigned.v1.js";
import { attributionTouchpointCapturedV1PropertiesSchema } from "../events/attribution/touchpoint_captured.v1.js";
import { checkoutStartedV1PropertiesSchema } from "../events/checkout/started.v1.js";
import { enrichedGeoipV1PropertiesSchema } from "../events/enriched/geoip.v1.js";
import { identityLinkRejectedV1PropertiesSchema } from "../events/identity/link_rejected.v1.js";
import { identityLinkedV1PropertiesSchema } from "../events/identity/linked.v1.js";
import { identityLinkedV2PropertiesSchema } from "../events/identity/linked.v2.js";
import { identityMergeSuspendedV1PropertiesSchema } from "../events/identity/merge_suspended.v1.js";
import { identityMergedV1PropertiesSchema } from "../events/identity/merged.v1.js";
import { identityMergedV2PropertiesSchema } from "../events/identity/merged.v2.js";
import { identityRotatedV1PropertiesSchema } from "../events/identity/rotated.v1.js";
import { paymentApprovedV1PropertiesSchema } from "../events/payment/approved.v1.js";
import { profileUpdatedV1PropertiesSchema } from "../events/profile/updated.v1.js";
import { signupCompletedV1PropertiesSchema } from "../events/signup/completed.v1.js";
import { subscriptionRenewedV1PropertiesSchema } from "../events/subscription/renewed.v1.js";
import { userIdentifiedV1PropertiesSchema } from "../events/user/identified.v1.js";
import { pageViewedV1PropertiesSchema } from "../events/page/viewed.v1.js";
import { pageViewedV2PropertiesSchema } from "../events/page/viewed.v2.js";
import { sessionEndedV1PropertiesSchema } from "../events/session/ended.v1.js";
import { sessionStartedV1PropertiesSchema } from "../events/session/started.v1.js";
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
  {
    event: "identity.linked",
    schema_version: 1,
    propertiesSchema: identityLinkedV1PropertiesSchema,
  },
  {
    event: "identity.merged",
    schema_version: 1,
    propertiesSchema: identityMergedV1PropertiesSchema,
  },
  {
    event: "identity.rotated",
    schema_version: 1,
    propertiesSchema: identityRotatedV1PropertiesSchema,
  },
  {
    event: "session.started",
    schema_version: 1,
    propertiesSchema: sessionStartedV1PropertiesSchema,
  },
  {
    event: "session.ended",
    schema_version: 1,
    propertiesSchema: sessionEndedV1PropertiesSchema,
  },
  {
    event: "enriched.geoip",
    schema_version: 1,
    propertiesSchema: enrichedGeoipV1PropertiesSchema,
  },
  {
    event: "attribution.touchpoint_captured",
    schema_version: 1,
    propertiesSchema: attributionTouchpointCapturedV1PropertiesSchema,
  },
  {
    event: "attribution.first_touch_assigned",
    schema_version: 1,
    propertiesSchema: attributionFirstTouchAssignedV1PropertiesSchema,
  },
  {
    event: "attribution.last_touch_assigned",
    schema_version: 1,
    propertiesSchema: attributionLastTouchAssignedV1PropertiesSchema,
  },
  {
    event: "identity.linked",
    schema_version: 2,
    propertiesSchema: identityLinkedV2PropertiesSchema,
  },
  {
    event: "identity.merged",
    schema_version: 2,
    propertiesSchema: identityMergedV2PropertiesSchema,
  },
  {
    event: "identity.link_rejected",
    schema_version: 1,
    propertiesSchema: identityLinkRejectedV1PropertiesSchema,
  },
  {
    event: "identity.merge_suspended",
    schema_version: 1,
    propertiesSchema: identityMergeSuspendedV1PropertiesSchema,
  },
  {
    event: "profile.updated",
    schema_version: 1,
    propertiesSchema: profileUpdatedV1PropertiesSchema,
  },
  {
    event: "payment.approved",
    schema_version: 1,
    propertiesSchema: paymentApprovedV1PropertiesSchema,
  },
  {
    event: "user.identified",
    schema_version: 1,
    propertiesSchema: userIdentifiedV1PropertiesSchema,
  },
  {
    event: "signup.completed",
    schema_version: 1,
    propertiesSchema: signupCompletedV1PropertiesSchema,
  },
  {
    event: "subscription.renewed",
    schema_version: 1,
    propertiesSchema: subscriptionRenewedV1PropertiesSchema,
  },
];
