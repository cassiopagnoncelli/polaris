# P11-001: Production Dockerfiles

Status: Done

## Goal

Add production Dockerfiles for Node services that run compiled JavaScript in slim containers.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Claude Instructions](../../instructions/claude.md)

## Dependencies

- P2-001
- P4-001
- P9-001

## Write Scope

Allowed:

```text
apps/*/Dockerfile
processors/*/v*/Dockerfile
consumers/*/v*/Dockerfile
infra/docker/
package.json
```

Forbidden:

```text
semantic source changes unrelated to containerization
```

## Implementation Notes

- Production containers run built JavaScript, not TypeScript source.
- Include build/version metadata.
- Keep Dockerfiles boring and explicit.
- Do not add runtime TypeScript execution.

## Acceptance Criteria

- [x] Dockerfiles exist for runnable services/processors/consumers.
- [x] Images run compiled JS.
- [x] Build metadata is included or injectable.
- [x] Dockerfiles do not bake secrets.
- [x] Local build command is documented.

## Checks

Run where possible:

```text
docker build --help
pnpm build
```

## Handoff

```text
Files changed:
  .dockerignore                                            (new)
  apps/control-plane-api/Dockerfile                        (new)
  apps/ingester-api/Dockerfile                             (new)
  apps/polaris-cli/Dockerfile                              (new)
  consumers/meta-capi/v1/Dockerfile                        (new)
  consumers/webhook-sink/v1/Dockerfile                     (new)
  infra/docker/README.md                                   (new)
  infra/docker/base.Dockerfile                             (new, reference template)
  infra/docker/build-args.md                               (new)
  processors/analytics-projector/v1/Dockerfile             (new)
  processors/geoip-enricher/v1/Dockerfile                  (new)
  processors/identity-resolver/v1/Dockerfile               (new)
  processors/sessionizer/v1/Dockerfile                     (new)
  package.json                                             (docker:build scripts)
  scripts/docker-build.mjs                                 (new)

Commands run:
  pnpm install
  pnpm build                       (required to seed d.ts before typecheck)
  pnpm typecheck                   (clean)
  pnpm lint                        (4 pre-existing warnings, none from this task)
  pnpm format:check                (clean)
  pnpm test                        (1574 passed, 1 skipped; scripts 59 passed)
  node scripts/docker-build.mjs --list
  node scripts/docker-build.mjs --dry-run ingester-api

Checks passed:
  typecheck, lint (no new warnings), format:check, test, build script smoke
  (list + dry-run). Hadolint is not installed locally; Dockerfile patterns
  were eyeball-validated against docs/architecture/09-engineering-standards.md
  "Containers" and 11-production-readiness.md.

Known gaps:
  - processors/identity-resolver/v1 has no src/main.ts entrypoint as of the
    P8-002 skeleton. Its Dockerfile is in place so the build inventory is
    complete, but `docker build` on that one Dockerfile will fail at the
    `test -f /deploy/dist/main.js` sanity check until the runtime entry
    lands. Documented in infra/docker/README.md "Known gaps".
  - processors/attribution-engine/v1 (P8-005) is not yet in the repository
    and is therefore not in the inventory. Adding it is a one-line edit to
    scripts/docker-build.mjs once the service exists.
  - No actual `docker build` was executed (heavy operation, per task brief).
    First real builds against this set should be CI-driven.
```

