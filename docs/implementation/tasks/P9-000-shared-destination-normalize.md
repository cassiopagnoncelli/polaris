# P9-000: Shared Destination Normalization Package

Status: Ready

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

- [ ] Package exists in workspace.
- [ ] `email`, `phone`, `external-id`, `currency`, `timestamp`, `hashing`, `consent` modules exist.
- [ ] Each helper is deterministic in tests (same input → same output across multiple invocations).
- [ ] Tests verify no raw PII is logged.
- [ ] Tests cover at least one vendor-specific divergence (e.g., GA4 timestamp format vs Meta epoch-seconds).
- [ ] Package has zero runtime dependencies on `apps/`, `processors/`, or `consumers/`.

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
Commands run:
Checks passed:
Known gaps:
```
