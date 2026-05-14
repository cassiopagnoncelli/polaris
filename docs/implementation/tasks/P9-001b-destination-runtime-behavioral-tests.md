# P9-001b: Destination Consumer Runtime — Behavioral Test Matrix

Status: Done (merged in `f6318c3`)

## Goal

Cover the destination consumer runtime's per-message pipeline with behavioral tests so the 1,165-line `runtime.ts` is no longer shipping un-exercised. The P9-001 salvage landed the public surface (constants, factories, types) verified by smoke tests; this task verifies that the pipeline actually does what the architecture says.

## Required Reading

- [P9-001 task card](./P9-001-destination-consumer-runtime.md) (parent, merged in `34c4fe8`)
- [Destinations](../../architecture/06-destinations.md) (binding — three-stage pipeline contract)
- [P9-000 normalize package](./P9-000-shared-destination-normalize.md) (the NORMALIZE step this runtime composes over)
- `packages/shared-destinations/src/runtime.ts` — the code under test
- `packages/shared-destinations/test/smoke.test.ts` — the existing surface-pinning tests

## Dependencies

- P9-001 (Done, partial — runtime + 11 smoke tests; behavioral tests pending)

## Write Scope

Allowed:

```text
packages/shared-destinations/test/
packages/shared-destinations/src/
```

Forbidden:

```text
apps/
processors/
consumers/
packages/shared-destination-normalize/
packages/shared-kafka/
db/migrations/
```

Source-side edits in `packages/shared-destinations/src/` are allowed only when the runtime needs a test seam (e.g. exposing an internal pure function so the test can drive it directly without spinning up a KafkaJS mock). Behavior cannot change.

## Implementation Notes

Per `docs/architecture/06-destinations.md`, the runtime handles each message through:

```text
subscribe -> replay-suppress -> rate-limit -> normalize -> map -> deliver -> RECORD
```

Each branch needs a behavioral test. Drive the tests through `createDestinationConsumer({...}).handleEvent(input)` so they bypass KafkaJS but exercise the real per-message handler.

### Per-branch test plan

Add `packages/shared-destinations/test/runtime-behaviors.test.ts` with these cases:

1. **Happy path** — normalized event with `consent.marketing=true` and a known mapper → `deliverer` called with the mapped payload + resolved secret; `delivery_records` row written with `status='delivered'`; consumed + delivered metric counters increment.

2. **`consent_not_granted` drop** — envelope has `consent.marketing=false`, destination requires `marketing=true` → `delivery_records` row with `status='dropped_consent'`; mapper not invoked; deliverer not invoked.

3. **`no_usable_identity` drop** — envelope has empty identity → `status='dropped_no_identity'`; mapper not invoked.

4. **Mapper throws** — mapper raises a regular Error → `status='mapped_failed'`, `error_class='mapping'`; deliverer not invoked; no DLQ publish.

5. **Mapper returns `skip`** — `MapperResult` of kind `'skip'` with reason → `status='dropped'` (or whatever the skip path writes) with that reason in `vendor_response_summary`; deliverer not invoked.

6. **Deliverer accepts** — returns `{ kind: 'accepted', vendor_response_code: '200' }` → `status='delivered'`, vendor response code/summary stamped, dedupe key recorded.

7. **Deliverer transient failure** — returns `{ kind: 'failed_retryable', error_class: 'transient', ... }` → `status='failed_retryable'`; KafkaJS-style retry is the host's concern (re-throw from the handler so the host wraps with `republishToDlq` after attempt cap); the delivery_record carries `attempt=N`.

8. **Deliverer permanent failure** — returns `{ kind: 'failed_permanent', error_class: 'permanent', ... }` → `status='failed_permanent'`; the runtime publishes to the destination's DLQ topic via `publishToDestinationDlq`; metric counter `polaris_destination_events_dlq_total` increments.

9. **Destination instance is `paused`** — reader returns an instance with `status='paused'` → request short-circuits with `dropped` (no normalize, no map, no deliver); metric `polaris_destination_events_skipped_total` increments.

10. **Destination instance is `mode='test'`** — read but do not deliver; the runtime stamps the delivery_record but skips the deliverer call.

11. **Replay-suppression: incoming `polaris-replay=true` + `allowReplay=false`** → request dropped before normalize; metric `polaris_destination_events_replay_suppressed_total` increments. With `allowReplay=true`, the request proceeds normally.

12. **Idempotent dedupe** — same `(destination_id, event_id, stage versions)` arrives twice → second call hits the dedupe layer and returns `skipped` without re-delivering; metric `polaris_destination_events_deduped_total` increments.

13. **Rate-limiter wait** — `DestinationRateLimiter` returns a lease after a non-zero wait → the wait duration is observed on the `polaris_destination_rate_limit_wait_ms_last` gauge.

14. **Secret resolution is per-attempt** — the runtime resolves the `secret_ref` on every delivery attempt (not at startup); the resolved value never appears in the `delivery_records` row or any log line. Verify by intercepting the secret resolver and asserting the stored row has no secret-shaped substring.

15. **Vendor response summary truncation** — a `vendor_response_summary` longer than `VENDOR_RESPONSE_SUMMARY_MAX_LENGTH` is clamped (`truncateSummary` already does this; the test asserts the final row).

### Test infrastructure

Each case wires:
- `InMemoryDestinationInstanceReader` with a single seeded destination row.
- `InMemoryDeliveryRecordRepository` to capture writes for assertion.
- A stub mapper that returns the result the test demands.
- A stub deliverer that returns the result the test demands.
- A stub `SecretResolver` that returns `'<test-secret>'`.
- A stub `PolarisProducer` for the DLQ assertions.

Drive each case through `createDestinationConsumer({...}).handleEvent({...})` and assert against:
- The `delivery_records` rows captured by the in-memory repo.
- The `DestinationMetrics.getSamples()` snapshot.
- The DLQ producer's `.send()` invocations.

If the runtime's current shape makes any of these branches awkward to test (e.g. the secret resolution is buried inside a closure that the test can't inject), add a minimal test seam — for example, expose the per-message handler factory so the test can wire a custom secret resolver.

## Acceptance Criteria

- [ ] `packages/shared-destinations/test/runtime-behaviors.test.ts` covers the 15 cases above.
- [ ] Every `DeliveryRecordStatus` in the closed set has at least one test that reaches it.
- [ ] DLQ path is exercised end-to-end (stub producer asserts the DLQ headers + payload).
- [ ] Secret value never appears in any captured `delivery_records` row.
- [ ] Existing 11 smoke tests still pass.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` green.

## Checks

```text
pnpm typecheck
pnpm --filter @polaris/shared-destinations test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
