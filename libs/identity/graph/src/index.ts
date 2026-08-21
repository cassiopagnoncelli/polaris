/**
 * `@polaris/identity-graph` — the graph, the port, and the decision.
 *
 * One of the four modules ADR-0007 decomposes the identity subsystem
 * into, and the one carrying the platform's correctness property:
 * `resolveIdentity` is what a replay re-runs, so what it produces from a
 * given event stream is the definition of a correct profile plane.
 *
 * A unit wanting to resolve events supplies an `IdentityGraphStore`
 * scoped to one transaction and calls `resolveIdentity`. Nothing here
 * opens a connection, reads a clock, or knows a stream exists.
 */

export {
  bindingKey,
  type GraphProfile,
  type GraphScope,
  type IdentifierBinding,
} from "./model.js";
export type { IdentityGraphStore, LinkRecord, MergeRecord } from "./port.js";
export { resolveIdentity } from "./resolve.js";
