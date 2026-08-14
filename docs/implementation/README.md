# Polaris Implementation Playbook

This playbook turns the Polaris architecture docs into small implementation tasks that a coding agent can execute one at a time.

Use it with Claude or any other coding worker. The worker should not make architecture decisions. It should read the docs, take one task, stay inside the write scope, run the requested checks, and hand back a concise diff summary.

## Source Documents

Every worker must read:

- [Project README](../README.md)
- [Claude Instructions](../instructions/claude.md)
- The task-specific architecture docs listed on its task card
- The assigned task card

The architecture docs are authoritative. If a task conflicts with them, stop and mark the task blocked.

## Kanban

The implementation board lives at:

- [Implementation Kanban](./kanban.md)
- [Delivery Roadmap](./delivery-roadmap.md)
- [Pipeline Redesign Plan](./pipeline-redesign-plan.md) — the accepted R programme (post-P12)
- [Coverage Matrix](./coverage-matrix.md)

The kanban is intentionally Markdown-based so a human coordinator or a single active worker can update it without a separate tool.

Recommended status flow:

```text
Ready -> In Progress -> Review -> Done
                 |
                 v
              Blocked
```

## Worker Rule

One worker takes exactly one task card.

The worker must:

1. Read the required docs.
2. Confirm the task ID and write scope.
3. Inspect the current files.
4. Make only the requested changes.
5. Run the requested checks where possible.
6. Update the task handoff note.
7. Stop.

The worker must not:

- edit files outside the write scope
- start a second task
- silently change architecture
- introduce new frameworks without the task asking for it
- move semantic truth into PostgreSQL
- rename Polaris to Panda
- treat RabbitMQ as the platform

## Parallelism Policy

Parallel workers are allowed only when their write scopes do not overlap.

Safe early parallel groups:

```text
P0-001 workspace skeleton
P1-001 local core compose
P1-003 ClickHouse DDL skeleton
```

Do not parallelize tasks that touch shared package exports, root tooling, or integration tests unless a coordinator has checked the scopes.

## Branch or Worktree Policy

Prefer one branch or worktree per task:

```text
agent/P0-001-workspace-skeleton
agent/P1-001-local-core-compose
agent/P2-001-ingester-shell
```

If using multiple Claude sessions, use separate worktrees. Do not let two sessions edit the same checkout.

## Definition of Done

A task is done when:

- the requested files are implemented
- the task acceptance criteria are satisfied
- requested checks pass, or failures are documented
- changed files are listed in the task handoff
- architectural deviations are absent or explicitly blocked for review

## Implementation Sequence

The first milestone is the vertical slice:

```text
workspace + tooling
local core infra
shared contracts
ingester publishes raw.events
SDK sends one event
processor emits analytics.events
ClickHouse persists analytics rows
smoke test proves the path
```

After that, grow breadth: stronger SDK persistence, replay jobs, destination consumers, observability dashboards, and control-plane ergonomics.

For product delivery, continue through:

```text
P6  Control-plane CLI
P7  Replay system
P8  Production processors
P9  Destination consumers
P10 Observability and operations
P11 Deployment, security, and data lifecycle
P12 Release readiness
```

See [Delivery Roadmap](./delivery-roadmap.md) for exit criteria.

P0–P12 are complete. Current programme: the pipeline redesign
(R0L–R11) — see the roadmap's Post-P12 section and the
[Pipeline Redesign Plan](./pipeline-redesign-plan.md).

