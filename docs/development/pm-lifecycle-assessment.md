# pm Lifecycle Stages — Assessment

The pm board defines eight active stages plus two terminal stages. This
document audits each one: what it's for, what audit signal it
generates, and whether it earns its keep. Recommendations are scoped
to the v1 board protocol — execution of any merge or removal would
need its own card.

## Lifecycle today

```text
backlog -> todo -> doing -> in_review -> ready -> merging -> done
                     |           |          |
                     v           v          v
                  blocked     blocked    blocked

discarded is reachable from any non-terminal active stage.
```

## Stage-by-stage assessment

### backlog

- **Purpose.** Holding area for ideas the team accepts but is not yet
  willing to put into the actionable pool.
- **Audit signal.** `new` event with `status="backlog"`. A subsequent
  `move backlog -> todo` records the moment the idea was promoted to
  actionable work.
- **Observed usage.** Zero cards have lived in `backlog` across the
  current 78-card done history. The team has been using `todo` as the
  single entry stage. The `next` query already excludes `backlog`, so
  the distinction is purely organisational.
- **Recommendation: MERGE INTO `todo`.** Collapse `backlog` and `todo`
  into a single entry-point stage. A `priority` value of `P4` (the
  existing lowest tier) already expresses "not urgent." Removing
  `backlog` simplifies the "what's in flight" mental model and the
  `ALLOWED_TRANSITIONS` table by one row. The migration is the safest
  in the table because no cards live there today.
- **Migration cost (if approved).** Mechanical: drop the `backlog`
  folder, remove from `STAGES` / `ACTIONABLE_STAGES` /
  `ALLOWED_TRANSITIONS`, update `next` to ignore the (now removed)
  status. No card moves required.

### todo

- **Purpose.** Actionable, unblocked, awaiting a claim.
- **Audit signal.** Source of `claim` events that flip cards to
  `doing`.
- **Recommendation: KEEP.** Primary input to `next`. Removing it
  would require a different "ready to claim" filter, gaining nothing.

### doing

- **Purpose.** Claimed and in implementation. Carries `owner`,
  `worker_thread`, `worktree`, `branch`.
- **Audit signal.** `claim` event sets all four owner fields; the
  stage prevents accidental dual-claims via the
  `validate_unique_active_metadata` check on `branch` and `worktree`.
- **Recommendation: KEEP.** Operationally critical — the only stage
  that lets the orchestrator answer "who has my worktree?" without
  walking the audit log.

### in_review

- **Purpose.** Implementation done, awaiting reviewer sign-off.
- **Audit signal.** `move doing -> in_review` event marks the
  hand-off point.
- **Observed usage.** Every recent done card includes a "review
  happened pre-merge in the worker thread" note. The stage is a
  rubber stamp: implementers move themselves through it because
  `ready` requires arriving from `in_review`. No card has been bounced
  back from `in_review` to `doing` in the audit history.
- **Recommendation: WATCH, do not remove yet.** The protocol value of
  `in_review` is that future workflows (an external reviewer, a CI
  bot, a paired reviewer) can plug into the existing transition
  without a protocol change. Removing it now to save one transition
  for a workflow we may want in three months is premature.
- **If the rubber-stamp pattern persists past 2026-Q3.** Revisit and
  consider collapsing `doing -> ready` directly. Keep this card open
  as a watch item rather than acting now.

### ready

- **Purpose.** Reviewed, awaiting integration grouping.
- **Audit signal.** `move in_review -> ready` event. The `ready`
  pool is the input to `integration-plan` and `integration-start`.
- **Recommendation: KEEP.** This is the buffer between "done with
  implementation" and "currently being merged." Without it,
  `integration-start` would need a separate "approved-not-yet-in-
  flight" flag, gaining nothing.

### merging

- **Purpose.** Integration branch in flight; cards in this stage have
  `integration_branch` set.
- **Audit signal.** `integration_start` event records the branch and
  the cards. `integration_finish` clears the stage as it transitions
  to `done`.
- **Recommendation: KEEP.** Distinct semantics from `ready` (=
  approved, replayable) vs `merging` (= in flight, do not replay
  onto). Even when short-lived, the stage carries the integration
  branch reference and lets `integration-abort` find the right
  cards.
- **Card author's suggestion (`ready` vs `merging` collapse with a
  flag).** Rejected: a flag-based encoding still needs distinct
  query paths (cards-on-this-branch vs cards-ready-for-any-branch).
  The two-stage model carries the same information with less code.

### blocked

- **Purpose.** Dependency unmet or external blocker. Carries
  `blocked_from` (origin stage) and now `last_block_reason`
  (M0TMMAKM).
- **Audit signal.** `block` event records blockers and reason; the
  `blocked_from` field lets `unblock` restore the prior stage cleanly.
- **Recommendation: KEEP.** Out of scope for removal — the stage
  carries unique state (`blocked_from`, `last_block_reason`) that
  doesn't map onto any other stage.

### done

- **Purpose.** Terminal success.
- **Audit signal.** `move ... -> done` (typically via
  `integration_finish`); clears all active fields per
  `clear_active_metadata`.
- **Recommendation: KEEP.** Terminal stage; required to express
  completion separately from abandonment.

### discarded

- **Purpose.** Terminal abandonment.
- **Audit signal.** Reachable from any non-terminal stage so a card
  abandoned mid-flight retains its prior trajectory in the audit log.
- **Recommendation: KEEP.** Removing it would force abandoned cards
  to land in `done`, polluting completion analytics.

## Summary

| Stage      | Recommendation | Rationale (1-line) |
|------------|----------------|--------------------|
| backlog    | Merge into `todo` | Zero observed usage; collapse simplifies the entry-point story |
| todo       | Keep | Primary input to `next`; no alternative carries the same query |
| doing      | Keep | Carries `owner`/`branch`/`worktree`; uniqueness checks rely on it |
| in_review  | Watch | Currently a rubber stamp; keep for plug-in reviewer workflows; revisit if pattern persists past 2026-Q3 |
| ready      | Keep | Approved-and-replayable buffer feeding `integration-plan` |
| merging    | Keep | Carries integration_branch reference; distinct from `ready` |
| blocked    | Keep | Carries unique `blocked_from`/`last_block_reason` state |
| done       | Keep | Required terminal success state |
| discarded  | Keep | Required terminal abandonment state; separate from `done` for analytics |

## Net protocol change if approved

One stage removed (`backlog`), one stage flagged for re-evaluation
(`in_review`). Eight active stages → seven. `ALLOWED_TRANSITIONS`
loses one row. `next` keeps the same shape because it already
excludes `backlog`. No card moves required because `backlog` is
currently empty.

## Out of scope (explicit)

Execution of the `backlog`-removal migration is a follow-up card,
not this one. This document is a recommendation, not a change to
the protocol.
