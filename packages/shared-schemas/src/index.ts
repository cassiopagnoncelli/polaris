// Canonical envelope and primitives — the SDK-safe surface.

// Catalog loader / validator surface (file-backed; intended for the
// ingester process, not SDK distributions).
export * from "./catalog/index.js";
export * from "./envelope/index.js";
export {
  type AttributionFirstTouchAssignedV1Properties,
  attributionFirstTouchAssignedV1PropertiesSchema,
} from "./events/attribution/first_touch_assigned.v1.js";
export {
  type AttributionLastTouchAssignedV1Properties,
  attributionLastTouchAssignedV1PropertiesSchema,
} from "./events/attribution/last_touch_assigned.v1.js";
export {
  type AttributionCampaignTuple,
  type AttributionPrimaryIdentifierKind,
  type AttributionTouchpointCapturedV1Properties,
  attributionCampaignTupleSchema,
  attributionPrimaryIdentifierKindSchema,
  attributionTouchpointCapturedV1PropertiesSchema,
} from "./events/attribution/touchpoint_captured.v1.js";
export {
  type CheckoutStartedV1Properties,
  checkoutStartedV1PropertiesSchema,
} from "./events/checkout/started.v1.js";
export {
  type EnrichedGeoipV1Properties,
  enrichedGeoipV1PropertiesSchema,
  geoipCountryCodeSchema,
  geoipRegionCodeSchema,
  geoipSourceIpHashSchema,
  geoipSourceSchema,
} from "./events/enriched/geoip.v1.js";
export {
  type IdentityLinkConfidence,
  type IdentityLinkedV1Properties,
  identityIdentifierSchema,
  identityLinkConfidenceSchema,
  identityLinkedV1PropertiesSchema,
} from "./events/identity/linked.v1.js";
export {
  type IdentityMergedV1Properties,
  identityMergedV1PropertiesSchema,
} from "./events/identity/merged.v1.js";
export {
  type IdentityRotatedV1Properties,
  identityRotatedV1PropertiesSchema,
} from "./events/identity/rotated.v1.js";
// Per-event property schemas. SDKs do NOT bundle these; they live here
// for ingester and processor consumption. Per `10-sdk-standards.md`, the
// Web SDK explicitly avoids bundling the event catalog.
export {
  type PageViewedV1Properties,
  pageViewedV1PropertiesSchema,
} from "./events/page/viewed.v1.js";
export {
  type PageViewedV2Properties,
  pageViewedV2PropertiesSchema,
} from "./events/page/viewed.v2.js";

// Schema-related machine-readable reason codes for batch responses.
export * from "./reason-codes.js";
export {
  parseViolationRecord,
  VIOLATION_RECORD_VERSION,
  type ViolationRecord,
  violationRecordSchema,
} from "./violation.js";
