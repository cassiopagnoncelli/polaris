/**
 * The id-graph model, and how a set of identifiers traverses to a person.
 *
 * The graph's RESOLVED STATE is the identifier bindings: `(project,
 * environment, kind, value) -> profile_id`. Its JUSTIFICATION is the
 * link ledger — why we believe two identifiers are one person — and the
 * two are deliberately different objects, written in the same
 * transaction.
 *
 * ## Traversal is one hop, always
 *
 * Repointing is eager: when two profiles merge, every one of the
 * loser's bindings moves to the winner inside that transaction. So a
 * binding always names a live profile, and `merged_into` is an AUDIT
 * pointer that readers never follow. Chains therefore never need
 * traversing, which is what keeps the read path a single lookup no
 * matter how many merges a person has been through.
 *
 * The tombstone is kept rather than deleted so historical `profile_id`
 * stamps in ClickHouse stay explainable through `profile_merges`.
 * ClickHouse resolves its own side through the merge map, which is the
 * same fact expressed as a dictionary — see
 * `@polaris/identity-components`.
 */

import type { StrongIdentityKind } from "@polaris/identity-rules";

/** Identity graphs are project-bounded; cross-project identity is out of scope. */
export interface GraphScope {
  readonly projectId: string;
  readonly environment: string;
}

/** One edge of the resolved graph: an identifier that names a profile. */
export interface IdentifierBinding {
  readonly kind: StrongIdentityKind;
  readonly value: string;
  readonly profileId: string;
}

/** The profile row the resolution reads and writes. */
export interface GraphProfile {
  readonly profileId: string;
  readonly canonicalCustomerId: string | null;
  readonly traits: Record<string, unknown>;
  readonly traitsVersion: number;
  readonly firstSeenAt: Date;
}

/** The key a binding is held under, for the already-bound lookup. */
export function bindingKey(identifier: { readonly kind: string; readonly value: string }): string {
  return `${identifier.kind}:${identifier.value}`;
}
