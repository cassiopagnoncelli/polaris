# P9-006: Braze Consumer v1

Status: Done

## Goal

Implement the first Braze destination consumer with stronger reliance on Polaris delivery records because vendor event dedupe may be weak.

## Required Reading

- [Destinations](../../architecture/06-destinations.md)
- [Event Contract](../../architecture/01-event-contract.md)
- [Control Plane](../../architecture/02-control-plane.md)

## Dependencies

- P9-001
- P0-008
- P6-004

## Write Scope

Allowed:

```text
consumers/braze/v1/
packages/shared-destinations/
docs/destinations/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
```

## Implementation Notes

- Assume weak or no generic vendor event dedupe.
- Enforce Polaris delivery idempotency before sending.
- Mapping semantics remain code-only.
- Use mock transport if live Braze credentials are unavailable.
- Ship `consumers/braze/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). The SPEC must include an explicit "Known divergences from canonical" entry noting that vendor dedupe is weak and that Polaris-side delivery-key idempotency is the canonical guard against double-delivery.

## Acceptance Criteria

- [x] Versioned consumer exists with manifest/changelog.
- [x] `SPEC.md` filled from the consumer SPEC template documents the Braze mapping, the dedupe-weakness divergence, and the Polaris-side idempotency contract.
- [x] At least one mapping is implemented in code.
- [x] Polaris delivery idempotency is tested.
- [x] Delivery records are written.
- [x] Replay suppression is honored.

## Checks

Run where possible:

```text
pnpm typecheck
pnpm test
pnpm lint
```

## Handoff

```text
Files changed:
  consumers/braze/v1/  (full tree — package.json, manifest, Dockerfile,
                       SPEC.md, CHANGELOG.md, tsconfig.json, vitest.config.ts,
                       src/{app,config,deliverer,descriptor,descriptor-identity,
                       index,main,mapper,types}.ts,
                       test/{config,deliverer,mapper,integration}.test.ts,
                       test/fixtures/{normalized.ts,checkout-started.input.json,
                       checkout-started.output.json})
  scripts/docker-build.mjs           — add braze entry (port 5004)
  infra/docker/README.md             — add braze v1 row in service table
  docs/implementation/tasks/P9-006-braze-consumer-v1.md  — status Done, AC checked

Commands run:
  cp -r consumers/tiktok consumers/braze
  rm -rf consumers/braze/v1/{dist,node_modules}
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm lint
  pnpm format:check  (after pnpm format fix-up)
  pnpm test

Checks passed:
  pnpm install        — workspace resolved (lockfile already at lockfileVersion 9.0)
  pnpm -r build       — all 28 workspace projects compile
  pnpm typecheck      — clean across all packages
  pnpm lint           — clean (4 pre-existing warnings in unrelated files)
  pnpm format:check   — clean
  pnpm test           — 162 test files / 1951 tests / 1 skipped pass
                        (4 braze test files / 63 braze tests pass)

Known gaps:
  - vendor_api_version is recorded as `rest` rather than a discrete v-number
    because Braze does not publish a path-versioned REST surface; a future
    breaking change on Braze's side requires a v2 of this consumer.
  - identityHashing.email/phone are disabled at the descriptor level so the
    shared normalize layer keeps raw email/phone for Braze's server-side
    hashing; the consumer also installs `identityFromProperties` to surface
    `properties.email` / `properties.phone` into the prepared identity
    because the canonical envelope's `identity` block does not carry the
    raw slots.
  - First/last name attribute mapping is not implemented — the canonical
    envelope does not currently carry a name slot. A future minor version
    may add it once a producer ships name data.
  - `user_alias` mapping for email-only / phone-only identities is not
    implemented; events without a usable `external_id` (customer_id or
    anonymous_id) produce a `skip` outcome at the mapper.
  - Live-vendor smoke against Braze's sandbox workspace is documented
    operationally but not run by CI (requires live credentials).
```

