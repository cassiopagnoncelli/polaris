---
id: 0009
title: One predicate evaluator, SQL semantics for absent traits
status: Accepted
date: 2026-08-21
deciders: architect
supersedes:
superseded_by:
related_card: R62PI
---

## Context and Problem Statement

One type, `AudiencePredicate`, had two evaluators, and they answered
differently about the same profile.

`libs/engage/audiences/src/predicate.ts` computes
`const known = present && value !== null && value !== undefined` and
short-circuits `if (!known) return false` **before** reaching any operator.
`libs/engage/journeys/src/machine.ts` read `const actual = traits[key]` and
fell straight into `case "ne": return actual !== predicate.value`.

So `{ trait: "orders_30d", op: "ne", value: 5 }` put a profile OUT of an
audience and sent the same profile down the `matched` arm of a journey.

The full divergence, measured against both implementations rather than read
off them. Absence has three spellings — a missing key, a `null` value, an
`undefined` value — and the answers were identical across all three:

| Operator | audiences | journeys |
|----------|-----------|----------|
| `eq`     | false | false |
| **`ne`** | **false** | **true** |
| `gt` `gte` `lt` `lte` | false | false |
| `in`     | false | false |
| `exists` | false | false |
| `absent` | true  | true  |

Measuring it also turned up a second divergence that nobody had filed, and
that `machine.ts`'s own comment got wrong — the comment claimed the two
disagreed about a key present-and-`null` versus missing, which they did not.
The real one is the prototype chain. `Object.hasOwn` versus a plain
`traits[key]` index read only differ on inherited keys, and
`definitions/audiences`'s trait-key rule — `^[a-z][a-z0-9_]{1,62}[a-z0-9]$` —
admits exactly one: `constructor`. A trait by that name resolved to
`Object.prototype.constructor` on every profile, so `exists` was true and
`absent` false for a trait nobody had ever set, for everybody.

`Q7COB` found the `ne` divergence while carving both evaluators into
`libs/engage` and deliberately did not merge them. It renamed the journeys
one to `evaluateJourneyPredicate`, documented the difference at the call
site, and filed the question. That was the right call: converging either
direction silently re-decides which arm a live participant takes, which is a
behaviour change wearing a refactor's clothes, and it is this file's job
rather than a commit message's.

Maturity tier assumed: **SMB**, per [0001]. No new infrastructure.

## Decision Drivers

- One type with two readings is the defect. Whichever answer is chosen, the
  cost of choosing wrong is bounded; the cost of not choosing is unbounded,
  because every new call site picks a side by accident.
- Audience membership is computed in the warehouse, at population scale, and
  the warehouse already reads NULL SQL's way. Agreeing with the engine that
  computes most predicates is the cheaper side to keep.
- The platform sends messages to people. Under the journeys reading an absent
  trait SATISFIES `ne`, so a profile the platform knows nothing about matches
  more conditions and gets targeted by more journeys. Excluding on unknown
  data is the conservative direction.
- The vocabulary already has `absent` and `exists` for authors who mean "has
  no value", so the strict reading costs an author nothing but length.
- Two implementations that are supposed to agree will drift again. Agreement
  enforced by a shared test is weaker than agreement enforced by there being
  one function.

## Considered Options

- Option A — Journeys adopts the audiences reading: SQL semantics everywhere
- Option B — Audiences adopts the journeys reading: two-valued, `ne` true on absent
- Option C — Keep both readings, document the difference as intentional, pin
  each with tests naming it
- Option D — Adopt SQL semantics, but keep two implementations kept honest by
  a shared conformance suite
- Option E — Hoist the evaluator into `@polaris/audience-catalog`, beside the
  type it evaluates

## Decision Outcome

Chosen: **Option A, implemented as a delegation** — against an absent trait
every comparison operator is false, `ne` included, and
`evaluateJourneyPredicate` becomes a one-line call to
`@polaris/engage-audiences`'s `evaluatePredicate`.

There is now one evaluator for `AudiencePredicate` in the platform. Journeys
keeps the name, because the call sites are journeys' — a branch's `when` and
an event trigger's `where` — but the dialect is gone, and with it the reason
the name existed.

Option D is rejected on the driver above: a conformance suite is a test that
two things agree, and the thing it tests is exactly the thing that should not
be possible to get wrong. Deleting one implementation is strictly stronger
and strictly less code.

Option E is the more principled home — the meaning of a predicate arguably
belongs beside the predicate's schema, and both libraries already depend on
that package. It is not taken here because `definitions/` is a catalog kind
under [0007]: declared intent and its schema, with the structural helpers
(`traitsReferenced`, `predicateDepth`) that validation needs. Evaluation
against profile data is meaning, which is what `libs/` is for, and moving it
would restate a package's kind to settle a question that a workspace
dependency already settles. `libs/engage/journeys` importing
`libs/engage/audiences` is domain-to-domain and legal under [0007]'s matrix;
`lint-import-direction.mjs` needed no new entry.

## Rollout

**This changes live behaviour.** Two call sites move: a branch's `when` in
`advance()`, and an event trigger's `where` in the orchestrator's admission
check. Any predicate that compares an absent trait with `ne` flips from true
to false; a trait named `constructor` stops reading as present.

**In-repo exposure is zero, and that is checked rather than assumed.**
`definitions/journeys/` holds one journey. `welcome_recent_purchasers`
triggers on `audience_entered` with no `where` clause, and its one branch is
`{ trait: "orders_30d", op: "gte", value: 2 }` — an ordered comparison, which
answered false against an absent trait under both readings. No shipped
definition changes arm. Journey definitions are code and deploy-time (see
`definitions/journeys/index.ts`); only PARTICIPATION is runtime state. So the
affected set is knowable statically at deploy time, and there is no runtime
population of author-written journeys to survey. A deployment carrying
private definitions audits them the same way: grep the registry for `op:
"ne"` and `op: "in"`, and cross-check the trait keys
`traitsReferencedByJourney` reports against what the trait runner actually
computes.

**What happens to participants already mid-journey.** Nothing retroactive.
A branch is evaluated at the moment it is REACHED, not at entry, and the arm
taken is not stored — so there is no cached decision to migrate, and no
participant is carrying one.

- A participant parked in a `wait` upstream of a branch evaluates that branch
  under the new rule when the sweep next claims them. This is the affected
  population, and it is exactly "has not reached the branch yet".
- A participant already past a branch keeps the arm it took. The machine does
  not revisit a branch it has walked through.
- Unless the graph loops back through a `wait`, which the catalog permits so
  long as some path reaches an exit. Such a participant re-reaches the branch
  on its next lap and takes the new arm then. This is the one case where a
  live participant visibly changes direction, and it is a property of the
  graph rather than of this change.

**Safe to apply in place; no pause required** for the definitions shipped
today, because none of them can change arm. A deployment whose own journeys
use `ne` or `in` against a trait that may be absent should run the audit
above first, and pause those journeys if the audit finds one — not because
the flip is unsafe mid-flight, but because the new arm is a different message
to a real person, and that is a decision the deployment owns.

## Consequences

- Positive: one profile, one answer. The two subsystems cannot disagree,
  because there is one function.
- Positive: a prototype-chain hole closes with the merge — the trait key
  `constructor` stops reading as present on every profile.
- Positive: the conservative reading wins by default. A profile the platform
  knows nothing about now matches fewer conditions, not more.
- Positive: `evaluateJourneyPredicate`'s docstring shrinks from an
  explanation of a divergence to a pointer at this record.
- Negative: `ne` is non-classical, and stays surprising. `orders_30d ne 5`
  excluding a profile whose `orders_30d` is unknown is correct here and reads
  wrong at a glance. Mitigated in the vocabulary rather than the code — see
  the note on `AUDIENCE_OPERATORS` in `definitions/audiences/types.ts`, which
  is where an author is standing when it matters.
- Negative: `libs/engage/journeys` gains a dependency on
  `libs/engage/audiences`, so a journey now needs the audiences package to
  build. Cheap — audiences' only dependency is the catalog journeys already
  had — but it is a real edge, and it points from the subsystem that walks
  participants to the one that computes populations.
- Follow-up work: none. The rollout audit is a deployment's, not this
  repository's.
- Conditions that would prompt a revisit: a third subsystem needing to
  evaluate `AudiencePredicate` without depending on `engage-audiences` would
  make Option E's hoist worth taking, and this decision's semantics would
  move with it unchanged.

## Pros and Cons of the Options

### Option A — Journeys adopts SQL semantics (chosen)

- Good: agrees with the warehouse, which computes most predicates.
- Good: conservative — unknown data targets fewer people, not more.
- Good: the vocabulary already has `absent`/`exists` for the other meaning.
- Bad: changes live journey behaviour, which is why this file exists.
- Bad: `ne` stays counter-intuitive for anyone reading it quickly.

### Option B — Audiences adopts the two-valued reading

- Good: `ne` means what a person naively expects.
- Good: no journey changes arm; nothing to roll out.
- Bad: on a new trait's first run, "has not ordered five times" means
  "everyone we have never computed" — nearly the whole population, targeted.
- Bad: disagrees with the warehouse that computes membership at scale.
- Bad: makes `null` comparable, so JavaScript coercion decides `lt: 1`.

### Option C — Two readings, documented as intentional

- Good: no behaviour change; the cheapest diff.
- Bad: does not fix the defect. One predicate type with two meanings stays a
  trap, and the next call site picks a side by accident.
- Bad: the difference was already documented at the call site, and the
  documentation was partly wrong — it named a divergence that did not exist
  and missed one that did.

### Option D — SQL semantics, two implementations, shared conformance suite

- Good: no new package dependency.
- Bad: tests that two functions agree, when one function cannot disagree.
- Bad: strictly more code than the chosen option, to buy less.

### Option E — Hoist the evaluator into the catalog package

- Good: the meaning of a predicate sits beside the predicate's schema.
- Good: no domain-to-domain package edge.
- Bad: puts evaluation against profile data in a catalog package, which
  [0007] scopes to declared intent and its schema.
- Bad: a larger structural move to settle a question a dependency settles.

[0001]: 0001-platform-architecture-ledger.md
[0007]: 0007-restructure-the-repository-around-six-object-kinds.md
