# P8-002b: Identity Resolver v1 — Behavioral Test Matrix

Status: Done (merged in `bac7bc2`)

## Goal

Cover `processors/identity-resolver/v1/` with behavioral tests. The processor shipped during the salvage of P8-002 (worker hit the org usage limit) with 1,508 LOC of `transform`, `emit`, `repository`, and `runtime` source and zero tests on disk. This task closes the gap with the same shape as P7-001b and P9-001b.

## Required Reading

- [P8-002 task card](./P8-002-identity-resolver-v1.md) (parent, merged in `a9dd1cf`)
- [Processors and Replay](../../architecture/05-processors-and-replay.md) — identity model
- `processors/identity-resolver/v1/src/transform.ts` — pure decision logic
- `processors/identity-resolver/v1/src/emit.ts` — envelope builders for `identity.linked` / `identity.merged` / `identity.rotated`
- `processors/identity-resolver/v1/src/repository.ts` — `IdentityLinkRepository` interface + in-memory adapter
- `processors/identity-resolver/v1/src/runtime.ts` — the streaming runtime
- `processors/analytics-projector/v1/test/` — closest model for the test layout
- `processors/sessionizer/v1/test/` — second model
- `processors/geoip-enricher/v1/test/` — third model

## Dependencies

- P8-002 (Done, partial — code shipped, tests deferred)

## Write Scope

Allowed:

```text
processors/identity-resolver/v1/test/
```

Forbidden:

```text
processors/identity-resolver/v1/src/   (unless a test seam is genuinely required;
                                        document any change here in the handoff)
packages/
apps/
db/migrations/
```

## Implementation Notes

The processor emits three events into `identity.events` per `05-processors-and-replay.md`:

- **`identity.linked`** — first time the resolver sees a `(strong, anonymous)` or `(strong, strong)` binding.
- **`identity.merged`** — when an anonymous_id that had a polaris_id is observed alongside a different user_id.
- **`identity.rotated`** — when a `reset()` event rotates the anonymous_id under an existing user_id.

The runtime composes:

```text
raw.events → decode → resolveIdentityCandidate (transform.ts)
  → branch:
      'none'                    → no emission, increment metric
      'authoritative_overlap'   → repository lookup → emit linked/merged/rotated
                                  → publish to identity.events
                                  → increment metric
```

### Test plan

Add four behavioral test files under `processors/identity-resolver/v1/test/`:

1. **`transform.test.ts`** — pure decisions, no I/O:
   - `resolveIdentityCandidate` returns `{ kind: 'none' }` when fewer than 2 authoritative identifiers are present.
   - Returns `{ kind: 'authoritative_overlap' }` with sorted left/right when 2+ are present.
   - `polaris_id` derivation is deterministic — same identity tuple, same output across multiple calls.
   - Edge: identity with `user_id` only → none.
   - Edge: identity with `user_id` AND `anonymous_id` → overlap.
   - Edge: identity with all four (`user_id`, `anonymous_id`, `session_id`, `device_id`) — pick the two highest-priority strong ids.

2. **`emit.test.ts`** — envelope builders:
   - `buildIdentityEventEnvelope` produces a canonical envelope with:
     - `event` ∈ `{identity.linked, identity.merged, identity.rotated}`
     - `event_id` set to the supplied UUIDv7
     - `processor` metadata stamped (name=identity-resolver, version=v1, ran_at)
     - `properties.source_event_id` references the raw event
     - the right `evidence_type` is on the properties
   - Stable serialization (same input → same output).

3. **`repository.test.ts`** — `InMemoryIdentityLinkRepository`:
   - `findByAnonymousId` returns `null` for unseen ids.
   - `insertLink` then `findByAnonymousId` returns the row.
   - `findByPolarisId` returns the binding's other side.
   - `supersedeLink` marks the prior row and chains the new one.
   - Multiple bindings under the same polaris_id all surface through `findByPolarisId`.

4. **`runtime.test.ts`** — per-message handler against in-memory repo + stub producer:
   - **emits `identity.linked`** when a fresh `(user_id, anonymous_id)` co-occurrence arrives.
   - **emits `identity.merged`** when an anonymous_id previously bound to polaris_id_X arrives alongside a user_id whose polaris_id differs.
   - **emits `identity.rotated`** when a `user.reset` event arrives that rotates the anonymous_id under an existing user_id.
   - **does NOT emit** on a `'none'` candidate.
   - **idempotent replay** — feeding the same raw envelope twice produces the same emission count.
   - **partition key on emission** uses the producer's `buildRawEventsPartitionKey` rule (or whatever shared-kafka helper the runtime uses).
   - **classifyError on malformed envelope** — terminal error path (no infinite retry).
   - **metric counters** increment on consume / emit / classify-fail.

Use the existing `InMemoryIdentityLinkRepository` (already in `src/repository.ts`) + a stub `PolarisProducer`. The runtime exposes `handleMessage` or similar; drive the tests directly through that to bypass KafkaJS. Inject deterministic `now()` and `newEventId()` hooks.

## Acceptance Criteria

- [ ] `processors/identity-resolver/v1/test/transform.test.ts` — pure decision coverage (≥ 6 cases).
- [ ] `processors/identity-resolver/v1/test/emit.test.ts` — envelope builder coverage (≥ 4 cases).
- [ ] `processors/identity-resolver/v1/test/repository.test.ts` — in-memory repo coverage (≥ 5 cases).
- [ ] `processors/identity-resolver/v1/test/runtime.test.ts` — emission matrix (linked / merged / rotated / none / replay / classify-error) (≥ 7 cases).
- [ ] Total ≥ 22 cases (matching the P9-001b precedent).
- [ ] `pnpm --filter @polaris/processor-identity-resolver-v1 test` green.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` workspace-wide green.
- [ ] No changes to `src/` beyond minimal test seams (and any change is documented in the handoff).

## Checks

```text
pnpm typecheck
pnpm --filter @polaris/processor-identity-resolver-v1 test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
