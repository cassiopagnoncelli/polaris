# P9-005: TikTok Consumer v1

Status: Done

## Goal

Implement the first TikTok destination consumer with code-only mappings and vendor dedupe support.

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
consumers/tiktok/v1/
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

- Use stable Polaris delivery IDs as vendor event IDs where supported.
- Do not place TikTok semantics upstream.
- Use mock transport if live TikTok credentials are unavailable.
- Ship `consumers/tiktok/v1/SPEC.md` filled from [the consumer SPEC template](../templates/consumer-spec-template.md). Document the TikTok Events API version targeted, the hashed identifier mapping (email, phone, external_id — TikTok rules mirror Meta closely), and `event_id` dedupe behavior.

## Acceptance Criteria

- [x] Versioned consumer exists with manifest/changelog.
- [x] `SPEC.md` filled from the consumer SPEC template documents at least one canonical event end-to-end with TikTok-specific normalization rules.
- [x] At least one mapping is implemented in code.
- [x] Vendor dedupe field handling is tested.
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
  consumers/tiktok/v1/CHANGELOG.md                           (new)
  consumers/tiktok/v1/Dockerfile                             (new; port 5003)
  consumers/tiktok/v1/SPEC.md                                (new; filled from template)
  consumers/tiktok/v1/consumer.manifest.yaml                 (new; vendor=tiktok, v1.3)
  consumers/tiktok/v1/package.json                           (new)
  consumers/tiktok/v1/tsconfig.json                          (new)
  consumers/tiktok/v1/vitest.config.ts                       (new)
  consumers/tiktok/v1/src/app.ts                             (new)
  consumers/tiktok/v1/src/config.ts                          (new)
  consumers/tiktok/v1/src/deliverer.ts                       (new)
  consumers/tiktok/v1/src/descriptor-identity.ts             (new)
  consumers/tiktok/v1/src/descriptor.ts                      (new)
  consumers/tiktok/v1/src/index.ts                           (new; module barrel)
  consumers/tiktok/v1/src/main.ts                            (new; binary entry)
  consumers/tiktok/v1/src/mapper.ts                          (new; 3 mappers)
  consumers/tiktok/v1/src/types.ts                           (new)
  consumers/tiktok/v1/test/config.test.ts                    (new)
  consumers/tiktok/v1/test/deliverer.test.ts                 (new)
  consumers/tiktok/v1/test/integration.test.ts               (new)
  consumers/tiktok/v1/test/mapper.test.ts                    (new)
  consumers/tiktok/v1/test/fixtures/normalized.ts            (new)
  consumers/tiktok/v1/test/fixtures/checkout-started.input.json   (new)
  consumers/tiktok/v1/test/fixtures/checkout-started.output.json  (new)
  scripts/docker-build.mjs                                   (modified; +tiktok entry)
  infra/docker/README.md                                     (modified; +tiktok row, port 5003)
  pnpm-lock.yaml                                             (regenerated)
Commands run:
  pnpm install
  pnpm -r build
  pnpm typecheck
  pnpm lint
  pnpm format:check  (one round of `biome format --write` on tiktok files)
  pnpm test
Checks passed:
  build, typecheck, lint, format:check, test (1829 + 59 script tests)
  consumer suite: 56 tests across config / mapper / deliverer / integration
Known gaps:
  - Mobile event_source (`app`) is not yet inferred; v1 routes mobile through `crm`
    until FlatContext carries app_* slots.
  - TikTok returns HTTP 200 with `code != 0` for some application-level errors; v1
    classifies on HTTP status alone. A future minor version may parse the body.
  - `first_name` / `last_name` (hashed) and `ttp` / `ttclid` cookies are not mapped
    in v1 — canonical envelope doesn't carry the slots; future minor version.
```

