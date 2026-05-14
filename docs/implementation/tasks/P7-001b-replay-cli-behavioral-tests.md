# P7-001b: Replay CLI Behavioral Tests + Store Surface Cleanup

Status: Ready

## Goal

Cover the hand-written `replay cancel|pause|resume|show` runners with behavioral tests against an in-memory store, and replace the `(store as any).findById` cast smell introduced during the P7-001 salvage with a clean typed interface.

## Required Reading

- [P7-001 task card](./P7-001-replay-job-model-cli.md) (parent, merged in `f670d28`)
- [Processors and Replay](../../architecture/05-processors-and-replay.md)
- [P6-004 destinations.disable test](../../../apps/polaris-cli/test/destinations-commands.test.ts) — closest existing analogue for the test shape
- [P6-005 processors.enable test](../../../apps/polaris-cli/test/processors-commands.test.ts) — same

## Dependencies

- P7-001 (Done, partial — runtime model + 6 commands shipped, only surface-pinning tests landed)

## Write Scope

Allowed:

```text
apps/polaris-cli/src/commands/replay/
apps/polaris-cli/test/
```

Forbidden:

```text
apps/ingester-api/
packages/web-sdk/
packages/node-sdk/
processors/
consumers/
db/migrations/
```

## Implementation Notes

### Surface cleanup

`apps/polaris-cli/src/commands/replay/{cancel,pause,resume}.ts` currently dispatch the existing-row lookup through a runtime cast:

```ts
// biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch for test stores
const dynamic = store as any;
if (typeof dynamic.findById === "function") {
  return (await dynamic.findById(id)) as ReplayJobRow | null;
}
```

This is fragile and bypasses the type system. Replace it with a typed store interface that includes `findById` on the surface itself. Each command's `ReplayCancelStore` / `ReplayPauseStore` / `ReplayResumeStore` interface gains:

```ts
findById(replayJobId: string): Promise<ReplayJobRow | null>;
```

The `defaultStore()` factory already returns an object that exposes the method via the trailing `as Store & { findById: ... }` cast — just promote `findById` into the public interface so the cast disappears.

### Tests

Add `apps/polaris-cli/test/replay-runner-behaviors.test.ts` covering:

1. **`create` happy path** — issues a `polaris_rpj_*` id, calls `insertWithAudit`, audit payload carries `actor_source='cli'` (the v1 default) and the full snapshot in `after`.
2. **`create` rejects `--from` older than 90 days** — surfaces `replay_window_exceeded`; no DB call made.
3. **`create` rejects planner-shaped flags** — uses the gate from validation.ts; throws `UsageError` BEFORE any store call.
4. **`list` filter passthrough** — `--status pending --project x --env staging --limit 10` reaches the store as the right `ListReplayJobsFilter`.
5. **`show <id>`** — happy path renders the full row; missing id → `UsageError`.
6. **`cancel <id>` happy path** — non-terminal row → `cancelled` outcome with `status='cancelled'` audit.
7. **`cancel <id>` idempotent** — already-terminal row → `already_terminal` outcome; no second cancellation; exits cleanly.
8. **`cancel <id>` race** — store's `cancelWithAudit` returns `not_found` mid-transaction; surfaced cleanly.
9. **`pause <id>` happy path** — `running` row → `paused`.
10. **`pause <id>` not-pausable** — `completed` row → `not_pausable` outcome.
11. **`resume <id>` happy path** — `paused` row → `resumed`.
12. **`resume <id>` not-paused** — `running` row → `not_paused` outcome.
13. **Audit payload shape** — every mutating runner threads `ctx.actor.source` and `ctx.actor.label` into the recorder; the snapshot's `before` is the row pre-mutation, `after` is the projected post-state.

Use an in-memory `Map<string, ReplayJobRow>` store that satisfies the typed interface. Inject deterministic UUIDv7 generators and `now()` so the test assertions can compare against fixed strings.

## Acceptance Criteria

- [ ] `ReplayCancelStore`, `ReplayPauseStore`, `ReplayResumeStore` each declare `findById` as a public method (no `as any` casts).
- [ ] `apps/polaris-cli/test/replay-runner-behaviors.test.ts` covers the 13 cases above.
- [ ] All existing P7-001 tests still pass.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check` green.

## Checks

```text
pnpm typecheck
pnpm --filter @polaris/polaris-cli test
pnpm lint
```

## Handoff

```text
Files changed:
Commands run:
Checks passed:
Known gaps:
```
