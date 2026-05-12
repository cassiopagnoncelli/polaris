# P9-000: Shared Destination Normalization Package

Status: Done (merged in `318afc0`)

## Goal

Create the workspace package that provides vendor-agnostic normalization primitives reused by every destination consumer.

## Required Reading

- [Destinations / Three Stages](../../architecture/06-destinations.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P0-001
- P0-002

## Write Scope

Allowed:

```text
packages/shared-destination-normalize/
package.json
pnpm-workspace.yaml
```

Forbidden:

```text
apps/
processors/
consumers/
packages/shared-destinations/
```

## Implementation Notes

- Package layout:

```text
packages/shared-destination-normalize/
  src/
    email.ts          lowercase + trim + sha256
    phone.ts          E.164 normalization + sha256
    external-id.ts    trim + sha256
    currency.ts       minor-unit conversion helpers
    timestamp.ts      epoch seconds, iso-8601 helpers
    hashing.ts        sha256 wrapper
    consent.ts        canonical consent shape to vendor-slot mapping helpers
  test/
```

- All helpers are deterministic and stateless. Same input always produces same output.
- No network calls. No file I/O. No `process.env` reads.
- Helpers never log raw PII. If logging is helpful for tests, log the hashed form.
- Hashing uses SHA-256 with the input normalized first (lowercase, trim) per the vendor expectations the helper documents. Each helper carries a docstring naming the vendors that share its normalization (e.g., Meta + TikTok share lowercase-trim-sha256 on email; GA4 uses something different).
- Where vendor rules diverge enough to need separate helpers, expose them as named exports rather than overloaded behavior.
- Export TypeScript types for the normalized intermediate shapes the destination runtime consumes.

## Acceptance Criteria

- [x] Package exists in workspace.
- [x] `email`, `phone`, `external-id`, `currency`, `timestamp`, `hashing`, `consent` modules exist.
- [x] Each helper is deterministic in tests (same input → same output across multiple invocations).
- [x] Tests verify no raw PII is logged.
- [x] Tests cover at least one vendor-specific divergence (e.g., GA4 timestamp format vs Meta epoch-seconds).
- [x] Package has zero runtime dependencies on `apps/`, `processors/`, or `consumers/`.

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
  packages/shared-destination-normalize/package.json                       (new)
  packages/shared-destination-normalize/tsconfig.json                      (new)
  packages/shared-destination-normalize/vitest.config.ts                   (new)
  packages/shared-destination-normalize/src/index.ts                       (new)
  packages/shared-destination-normalize/src/hashing.ts                     (new)
  packages/shared-destination-normalize/src/email.ts                       (new)
  packages/shared-destination-normalize/src/phone.ts                       (new)
  packages/shared-destination-normalize/src/external-id.ts                 (new)
  packages/shared-destination-normalize/src/currency.ts                    (new)
  packages/shared-destination-normalize/src/timestamp.ts                   (new)
  packages/shared-destination-normalize/src/consent.ts                     (new)
  packages/shared-destination-normalize/src/identity.ts                    (new)
  packages/shared-destination-normalize/src/context.ts                     (new)
  packages/shared-destination-normalize/src/normalize.ts                   (new)
  packages/shared-destination-normalize/test/fixtures.ts                   (new)
  packages/shared-destination-normalize/test/hashing.test.ts               (new)
  packages/shared-destination-normalize/test/email.test.ts                 (new)
  packages/shared-destination-normalize/test/phone.test.ts                 (new)
  packages/shared-destination-normalize/test/external-id.test.ts           (new)
  packages/shared-destination-normalize/test/currency.test.ts              (new)
  packages/shared-destination-normalize/test/timestamp.test.ts             (new)
  packages/shared-destination-normalize/test/consent.test.ts               (new)
  packages/shared-destination-normalize/test/identity.test.ts              (new)
  packages/shared-destination-normalize/test/context.test.ts               (new)
  packages/shared-destination-normalize/test/normalize.test.ts             (new)
  packages/shared-destination-normalize/test/no-pii-logging.test.ts        (new)
  packages/shared-destination-normalize/test/public-surface.test.ts        (new)
  docs/implementation/tasks/P9-000-shared-destination-normalize.md         (status/handoff update)

Commands run:
  pnpm install
  pnpm --filter @polaris/shared-destination-normalize build
  pnpm --filter @polaris/shared-destination-normalize typecheck
  pnpm --filter @polaris/shared-destination-normalize lint
  pnpm --filter @polaris/shared-destination-normalize test
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test

Checks passed:
  pnpm --filter @polaris/shared-destination-normalize test    91 tests passing across 12 files
  pnpm --filter @polaris/shared-destination-normalize lint    clean (Biome)
  pnpm --filter @polaris/shared-destination-normalize typecheck   clean (strict TS)
  pnpm typecheck                                                clean (repo-wide)
  pnpm lint                                                     clean (repo-wide + clickhouse-imports)
  pnpm format:check                                             clean (repo-wide)
  pnpm test                                                     1116 passed / 1 skipped (vertical-slice
                                                                  Docker smoke), 59 passed (scripts)
                                                                  — pre-existing flaky UUIDv7
                                                                  monotonic-ordering test in
                                                                  scripts/__tests__/smoke-harness.test.ts
                                                                  is unrelated to this task (introduced
                                                                  in P5-001, depends on random tail
                                                                  ordering within the same ms).

Known gaps:
  None blocking. The package ships the destination-agnostic NORMALIZE step
  (envelope conformance, defensive second-pass redaction, consent gate,
  identity preparation + best-available picker, context flattening,
  dual-form timestamp). Vendor-specific normalize stages live in
  consumers/<vendor>/v<n>/normalize/ (P9-002+) and compose on top of this
  package — they are out of scope for P9-000.
```
