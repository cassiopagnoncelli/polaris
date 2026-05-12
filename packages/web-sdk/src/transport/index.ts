/**
 * Transport surface for `@polaris/web-sdk`.
 *
 * The `Transport` interface itself lives with the other public types in
 * `../types.ts`. This entry point exposes the bundled fetch/sendBeacon
 * transport and the matching error class.
 */

export { HttpsTransport, type HttpsTransportOptions, TransportError } from "./https.js";
