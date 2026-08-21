/**
 * `@polaris/identity-rules` — which identifiers count, and within what
 * bounds.
 *
 * One of the four modules ADR-0007 decomposes the identity subsystem
 * into. This is the one with no state at all: given an envelope and a
 * project's policy, it says which identifiers are resolvable, in which
 * order, and which values are blocked. `@polaris/identity-graph` acts on
 * that answer; `@polaris/identity-merge` guards what happens when two
 * profiles collide.
 */

export {
  type CollectedIdentifier,
  type CollectOutcome,
  collectIdentifiers,
  type IdentityEnvelope,
  type IdentityPolicy,
  type StrongIdentityKind,
} from "./identifiers.js";
export {
  createPolicyResolver,
  MANIFEST_BOUNDS,
  MANIFEST_DEFAULTS,
  type ProjectIdentityOverride,
} from "./policy.js";
