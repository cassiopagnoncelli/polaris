// Canonical envelope and primitives — the SDK-safe surface.
export * from "./envelope/index.js";

// Per-event property schemas. SDKs do NOT bundle these; they live here
// for ingester and processor consumption. Per `10-sdk-standards.md`, the
// Web SDK explicitly avoids bundling the event catalog.
export {
  pageViewedV1PropertiesSchema,
  type PageViewedV1Properties,
} from "./events/page/viewed.v1.js";
export {
  pageViewedV2PropertiesSchema,
  type PageViewedV2Properties,
} from "./events/page/viewed.v2.js";
export {
  checkoutStartedV1PropertiesSchema,
  type CheckoutStartedV1Properties,
} from "./events/checkout/started.v1.js";
export {
  identityIdentifierSchema,
  identityLinkConfidenceSchema,
  identityLinkedV1PropertiesSchema,
  type IdentityLinkConfidence,
  type IdentityLinkedV1Properties,
} from "./events/identity/linked.v1.js";
export {
  identityMergedV1PropertiesSchema,
  type IdentityMergedV1Properties,
} from "./events/identity/merged.v1.js";
export {
  identityRotatedV1PropertiesSchema,
  type IdentityRotatedV1Properties,
} from "./events/identity/rotated.v1.js";

// Catalog loader / validator surface (file-backed; intended for the
// ingester process, not SDK distributions).
export * from "./catalog/index.js";

// Schema-related machine-readable reason codes for batch responses.
export * from "./reason-codes.js";
