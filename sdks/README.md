# SDKs

The published clients. `sdks/web` and `sdks/node` are the two first-party
targets; React, Ruby and mobile are deferred and land here when they land.

This tier is separate from `libs/` because it is a different kind of thing, not
a different subject. A library is internal: its callers are in this repository,
its surface is ours to change, and a rename is a refactor. An SDK is a product
artifact shipped into somebody else's codebase — its surface is a contract with
applications we do not control, so a change to it is a change to the data
contract and is expensive in the way an internal rename never is.

That is what earns the tier its own standards ledger. Everything here follows
[ADR-0003](../docs/adr/0003-sdk-standards-ledger.md), which settles surface
area, identity persistence, queueing, retry and lifecycle across every target
so the first SDK does not quietly set policy for the rest. Its review rule is
the short version: SDKs stay thin. Transport, identity and session, delivery
reliability, developer clarity — never enrichment, attribution, vendor logic or
schema governance.

Device-mode destinations will live here too, as plugins. A device-mode
destination runs in the producer's browser rather than in the pipeline, so it
ships inside the SDK bundle and inherits every line of ADR-0003; its
cloud-mode sibling under `connectors/destinations/` does not. The two halves of
one vendor integration therefore sit in different tiers on purpose — the
deciding question is where the code executes, not whose logo is on it.

Prose reference for consumers is [`docs/sdk/`](../docs/sdk/README.md); the
onboarding path is [`docs/onboarding/`](../docs/onboarding/README.md).
