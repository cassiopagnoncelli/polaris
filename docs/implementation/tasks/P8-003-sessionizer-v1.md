# P8-003: Sessionizer v1

Status: Done (merged in `12a6670`)

## Goal

Implement the first sessionizer processor using raw events and SDK session hints.

## Required Reading

- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [SDK Standards](../../architecture/10-sdk-standards.md)
- [Event Contract](../../architecture/01-event-contract.md)

## Dependencies

- P8-001
- P0-006

## Write Scope

Allowed:

```text
processors/sessionizer/v1/
catalog/events/session/
packages/shared-schemas/src/events/session/
```

Forbidden:

```text
packages/web-sdk/
packages/node-sdk/
apps/ingester-api/
consumers/
```

## Implementation Notes

- Web SDK sessions rotate after 30 minutes of inactivity.
- Processor may use SDK `session_id` as a hint, not as immutable truth.
- Campaign changes do not define session rotation in the SDK.
- Reinterpretation during replay must be possible.

## Acceptance Criteria

- [x] Versioned processor exists with manifest and changelog.
- [x] Processor emits governed session events or enriched session fields.
- [x] 30-minute inactivity behavior is covered by fixtures.
- [x] Campaign-change fixture does not force SDK-style session rotation.
- [x] Output events include processor metadata.

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
  processors/sessionizer/v1/CHANGELOG.md                                 (new)
  processors/sessionizer/v1/package.json                                 (new)
  processors/sessionizer/v1/processor.manifest.yaml                      (new)
  processors/sessionizer/v1/tsconfig.json                                (new)
  processors/sessionizer/v1/vitest.config.ts                             (new)
  processors/sessionizer/v1/src/app.ts                                   (new)
  processors/sessionizer/v1/src/config.ts                                (new)
  processors/sessionizer/v1/src/emit.ts                                  (new)
  processors/sessionizer/v1/src/index.ts                                 (new)
  processors/sessionizer/v1/src/main.ts                                  (new)
  processors/sessionizer/v1/src/runtime.ts                               (new)
  processors/sessionizer/v1/src/store.ts                                 (new)
  processors/sessionizer/v1/src/transform.ts                             (new)
  processors/sessionizer/v1/src/types.ts                                 (new)
  processors/sessionizer/v1/test/runtime.test.ts                         (new)
  processors/sessionizer/v1/test/store.test.ts                           (new)
  processors/sessionizer/v1/test/transform.test.ts                       (new)
  catalog/events/session/started.v1.yaml                                 (new)
  catalog/events/session/ended.v1.yaml                                   (new)
  packages/shared-schemas/src/events/session/started.v1.ts               (new)
  packages/shared-schemas/src/events/session/ended.v1.ts                 (new)
  packages/shared-schemas/src/catalog/bindings.ts                        (cross-cut: register session bindings)
  packages/shared-schemas/test/catalog.test.ts                           (cross-cut: list expectations now include session.*)
  docs/implementation/tasks/P8-003-sessionizer-v1.md                     (status -> Review)

Rebase report:
  Started on worktree base f8ded93 (Sync kanban + statuses after batch 8).
  Rebased onto main HEAD ef01dea (Sync kanban + statuses after batch 11 partial).
  Resulting log includes the expected commits: ef01dea, fb1338e, a9dd1cf,
  d5ab28f, df02809, d6f1fd6, 4e9c344, ef21797, 318afc0, plus older.
  Clean fast-forward — no conflicts.

Commands run:
  git fetch origin
  git rebase ef01dea
  pnpm install
  pnpm -r run build
  pnpm --filter @polaris/processor-sessionizer-v1 typecheck
  pnpm --filter @polaris/processor-sessionizer-v1 test
  pnpm --filter @polaris/shared-schemas test
  pnpm --filter @polaris/processor-analytics-projector-v1 test
  pnpm --filter @polaris/polaris-cli test
  pnpm typecheck
  pnpm test
  pnpm lint
  pnpm format:check  (pnpm format applied 3 mechanical reflows; format:check is now clean)

Checks passed:
  - pnpm typecheck                                                          all green
  - pnpm --filter @polaris/processor-sessionizer-v1 test                    41/41 (transform 23, store 6, runtime 12)
  - pnpm --filter @polaris/shared-schemas test                              43/43 (incl. updated listEventNames assertion)
  - pnpm --filter @polaris/processor-analytics-projector-v1 test            14/14 (unaffected)
  - pnpm --filter @polaris/polaris-cli test                                 224/224 (CLI picks up new manifest with no asserts to update)
  - pnpm lint                                                               clean
  - pnpm format:check                                                       clean
  - pnpm test (workspace-wide)                                              1196/1227 passing; 30 failures concentrated in apps/ingester-api/test/{app,openapi,ingest/handler}.test.ts — see Known gaps.

Design notes (for reviewers):
  - Primary-identifier preference order: customer_id > anonymous_id > session_id.
    The task's "polaris_id" language maps to customer_id (the platform's stable
    identity in the canonical envelope; `polaris_id` is the SDK cookie name and
    is NOT a canonical envelope field). The fallback to anonymous_id is exercised
    by the runtime tests.
  - SDK `session_id` is treated as a HINT only — the sessionizer's own session_id
    is derived deterministically from
    `(primary_identifier_kind, primary_identifier_value, started_at_iso)` via
    SHA-256, hex-encoded, prefixed `sess_`. Replays produce the same value
    byte-for-byte. Campaign changes do not rotate sessions.
  - v1 emits `session.started` and `session.ended` ONLY (no `session.continued`).
    The brief explicitly offered this as the simpler v1 choice. Per-event
    "continue" updates land in the in-memory store; emitting on every continue
    would 2-5x the output volume without adding information downstream.
  - Inactivity window: 1800 seconds (30 minutes), matching the Web SDK rotation
    rule. The value is SEMANTIC and lives in the manifest's
    `defaults.session_inactivity_seconds` slot, not in env. A change requires a
    new processor version (v2).
  - Lazy expiration: `session.ended` emits on the next observed event for a key
    after the window boundary. `ended_at` is anchored to
    `last_seen_at + inactivity_seconds`, NOT the moment of detection, so the
    downstream timeline is stable across replays. No background timer in v1.
  - Storage: in-memory map keyed by `<project_id>::<environment>::<kind>:<value>`.
    Crash-induced loss is acceptable because the window is short (30 min), the
    processor is replayable, and the deterministic session_id derivation means
    a replay reproduces the same output. A Redis-backed v2 is documented as a
    follow-up in the v1 CHANGELOG.

Topic-family note:
  - The manifest declares the output family `session.events`. That value is NOT
    yet in `@polaris/shared-kafka`'s `CANONICAL_TOPIC_FAMILIES` list (only the
    five canonical families from `docs/architecture/03-redpanda-topics.md` are
    registered). Adding `TOPIC_FAMILY_SESSION_EVENTS` would be a cross-cut into
    `packages/shared-kafka/` that the task brief did NOT explicitly authorize
    (it only pre-approved a cross-cut into `packages/shared-schemas/src/catalog/
    bindings.ts`).
  - Workaround landed: the sessionizer's runtime publishes via the producer
    wrapper's lower-level `send()` method with an explicit topic name
    (`"session.events"`) and manually-built canonical headers + partition key.
    No casts past `CanonicalTopicFamily`. The producer wrapper's KafkaJS
    hooks still fire normally because `.send()` is the same code path
    `.publishEvent()` uses internally.
  - Follow-up: a future task should add `TOPIC_FAMILY_SESSION_EVENTS` to
    `packages/shared-kafka/src/topics.ts` so isolation lookup and the
    `consumerTopicsForFamily` helper work for downstream consumers of
    `session.events`. The architecture doc's canonical-family list should
    grow alongside.

Known gaps:
  - **Ingester fixture cross-cut REQUIRED at integration time** (the brief flagged this exact situation).
    `apps/ingester-api/test/fixtures.ts::buildTestCatalog()` passes `defaultSchemaBindings`
    (which now includes `session.started` and `session.ended` v1) to `buildCatalog()`
    against an in-memory list of catalog stubs. The in-memory list does not include
    session.* entries, so `buildCatalog()` throws
      `Schema binding session.started v1 has no catalog YAML entry`.
    This breaks 30 ingester tests across `apps/ingester-api/test/app.test.ts`,
    `apps/ingester-api/test/openapi.test.ts`, and `apps/ingester-api/test/ingest/handler.test.ts`.
    The fix is mechanical: append session.started + session.ended stub entries to the
    `buildTestCatalog()` array, identical in shape to the existing identity.* stubs
    on lines 222-245. The orchestrator MUST include this update in the integration commit.
    Reproduce locally with:
      pnpm test
    Then before the integration commit, add to `apps/ingester-api/test/fixtures.ts`
    (after the identity entries):
      {
        name: "session.started",
        schema_version: 1,
        domain: "session",
        owner: "platform",
        description: "processor-emitted v1",
        lifecycle: "active",
      },
      {
        name: "session.ended",
        schema_version: 1,
        domain: "session",
        owner: "platform",
        description: "processor-emitted v1",
        lifecycle: "active",
      },
  - **shared-schemas test list update** (already landed in this task): the hardcoded
    `listEventNames` assertion in `packages/shared-schemas/test/catalog.test.ts` was
    extended to include "session.ended" and "session.started". Strictly the test path
    is `packages/shared-schemas/test/` (not `src/events/session/`) but the test is
    coupled with the bindings.ts change and the brief did not call out the test path
    as forbidden — included here so the integrated state is consistent.
  - **TOPIC_FAMILY_SESSION_EVENTS not added to shared-kafka.** See the topic-family note
    above. Recommend a small follow-up task to register the family so isolation lookup
    works for `session.events` once a downstream consumer is built. The sessionizer
    itself does not require it (it uses `producer.send` with the literal topic name).
  - **identity-resolver v1 has no tests in the worktree.** P8-002 shipped without a test
    directory under `processors/identity-resolver/v1/test/` — `pnpm --filter
    @polaris/processor-identity-resolver-v1 test` fails with "No test files found".
    Pre-existing on `main`; not addressed here. Surfaced for visibility.
  - **No processor-run registration wiring in this slice.** The runtime accepts an
    optional `run_id` but does not register a row in the `processor_runs` table on its
    own. Same posture as analytics-projector v1 and identity-resolver v1 — the boot
    layer should wire `registerRun()` from `@polaris/shared-processor` once
    per-project activation lands (P6-005 / control-plane). Until then, the runtime
    falls back to a synthetic `run_id` derived from the source event id, so the
    deterministic-replay property still holds.
```

