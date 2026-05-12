# P11-001: Production Dockerfiles

Status: Backlog

## Goal

Add production Dockerfiles for Node services that run compiled JavaScript in slim containers.

## Required Reading

- [Engineering Standards](../../architecture/09-engineering-standards.md)
- [Observability and Operations](../../architecture/08-observability-and-operations.md)
- [Codex Instructions](../../instructions/codex.md)

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

- [ ] Dockerfiles exist for runnable services/processors/consumers.
- [ ] Images run compiled JS.
- [ ] Build metadata is included or injectable.
- [ ] Dockerfiles do not bake secrets.
- [ ] Local build command is documented.

## Checks

Run where possible:

```text
docker build --help
pnpm build
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```

