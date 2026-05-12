# P11-007: Release Versioning and Build Metadata

Status: Backlog

## Goal

Implement version/build metadata conventions across packages, services, processors, and consumers.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [Destinations](../../architecture/06-destinations.md)

## Dependencies

- P11-001
- P8-006
- P9-001

## Write Scope

Allowed:

```text
packages/
apps/
processors/
consumers/
scripts/
docs/deployment/
```

Forbidden:

```text
semantic behavior changes unrelated to version metadata
```

## Implementation Notes

Expose:

```text
package version
git SHA
build timestamp
processor/consumer version
optional pipeline release label
```

Service health/version endpoints should include build metadata.

## Acceptance Criteria

- [ ] Shared build metadata helper exists.
- [ ] Services expose build/version info.
- [ ] Processor/consumer runs record exact version metadata.
- [ ] Docker build can inject git SHA/build timestamp.
- [ ] Docs explain hybrid versioning.

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

