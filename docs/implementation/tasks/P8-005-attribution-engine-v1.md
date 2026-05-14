# P8-005: Attribution Engine v1

Status: Done

## Goal

Implement the first conservative attribution processor using captured campaign/click context.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P8-003
- P0-006

## Write Scope

Allowed:

```text
processors/attribution-engine/v1/
catalog/events/attribution/
packages/shared-schemas/src/events/attribution/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
apps/ingester-api/
consumers/
```

## Implementation Notes

- The SDK captures campaign/click context but does not interpret attribution.
- Start with conservative deterministic rules.
- Do not add vendor-specific semantics upstream.
- Attribution rules are semantic processor behavior and must be versioned.

## Acceptance Criteria

- [x] Versioned processor exists with manifest and changelog.
- [x] Deterministic attribution fixtures exist.
- [x] Vendor-specific destination logic is absent.
- [x] Output events include processor metadata.
- [x] Replay notes describe how v1 behavior may affect historical outputs.

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
  - processors/attribution-engine/v1/
      package.json
      tsconfig.json
      vitest.config.ts
      processor.manifest.yaml
      CHANGELOG.md
      src/{app,config,emit,index,main,runtime,store,transform,types}.ts
      test/{emit,runtime,store,transform}.test.ts
  - catalog/events/attribution/
      first_touch_assigned.v1.yaml
      last_touch_assigned.v1.yaml
      touchpoint_captured.v1.yaml
  - packages/shared-schemas/src/events/attribution/
      first_touch_assigned.v1.ts
      last_touch_assigned.v1.ts
      touchpoint_captured.v1.ts
  - packages/shared-schemas/src/index.ts             (exports the 3 schemas)
  - packages/shared-schemas/src/catalog/bindings.ts  (registers the 3 events)
  - packages/shared-schemas/test/catalog.test.ts     (updated listEventNames)
  - apps/ingester-api/test/fixtures.ts               (added 3 entries to buildTestCatalog)
  - pnpm-lock.yaml                                   (new workspace package)

Commands run:
  pnpm install
  pnpm typecheck      -> green
  pnpm lint           -> green (4 pre-existing warnings in
                        shared-destinations/src/db/dlq-records.ts —
                        not introduced by this change)
  pnpm format:check   -> green
  pnpm test           -> 1639 passed / 1 skipped (the skipped one is the
                        smoke vertical-slice, gated on POLARIS_SMOKE_DOCKER)

Checks passed:
  - Versioned processor exists with manifest + changelog (immutable
    semantic definition; semver-style v1 directory).
  - Deterministic attribution fixtures exist: transform.test.ts +
    runtime.test.ts assert touchpoint_id determinism, replay
    reproduces identical touchpoint_captured ids byte-for-byte, and
    cross-identifier isolation.
  - Vendor-specific destination logic absent: click_id is a single
    catch-all field; no `gclid`/`fbclid`/`msclkid` splits. Manifest
    description, CHANGELOG, and a dedicated test
    ("treats click_id as a single catch-all field") all verify.
  - Output events include processor metadata: dual-shape stamp
    (nested `processor` block + flat `processor_name` /
     `processor_version`) on every emission. emit.test.ts +
    runtime.test.ts both assert.
  - Replay notes: CHANGELOG.md "Replay notes" + processor.manifest.yaml
    `replay.restrictions` document the first-touch and last-touch
    replay caveats explicitly.

Known gaps:
  - In-memory state only. A Redis-backed v2 will externalize the
    touchpoint chain so process restarts do not lose chains.
  - No background timer / no chain expiry. Long-running processes
    accumulate identifier state; a v2 may add LRU bounds or TTL sweep.
  - No conversion detection. v1 only surfaces the touchpoint chain;
    downstream analytics joins to commerce / conversion events.
  - No multi-touch attribution weights (linear, time-decay, U-shape,
    data-driven). Those are new processor versions.
  - Vendor-specific click_id splitting is out of scope. Downstream
    destinations interpret the catch-all `campaign.click_id`.
```

