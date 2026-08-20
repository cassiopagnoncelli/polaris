/**
 * Transport surface for `@polaris/node-sdk`.
 *
 * The `Transport` interface lives in `../types.ts`. This entry point
 * exposes the bundled HTTPS POST transport for operators that want to
 * construct it explicitly (e.g. to share an agent across multiple SDK
 * instances) and the matching error class.
 */

export { HttpsTransport, type HttpsTransportOptions, TransportError } from "./https.js";
