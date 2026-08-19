---
id: 0005
title: Externalise processor state stores, split by state shape
status: Accepted
date: 2026-08-11
deciders: architect
supersedes:
superseded_by:
---

## Context and Problem Statement

Two processors hold per-key working state in the process that computes it.

`processors/sessionizer/v1/src/store.ts` keeps an in-memory `Map` of open
session windows keyed by `<project_id>::<environment>::<kind>:<value>`.
`processors/attribution-engine/v1/src/store.ts` keeps an in-memory `Map`
of touchpoint chains on the same key shape. Both shipped with the
limitation recorded in their own module docs and CHANGELOGs: v1 is
in-memory, v2 externalises.

The two are not equally urgent, and treating them as one problem is what
this ADR exists to prevent.

The sessionizer's state is bounded and self-expiring. A session record is
alive for the inactivity window (30 minutes by default) and then must
die; `gcExpired()` exists for a sweep the runtime never calls, because
lazy expiration on the next event for a key is sufficient. Losing the map
costs at most one window of session continuity, and because `session_id`
derivation is deterministic, a replay from `raw.events` reproduces the
same output.

The attribution engine's state is neither. Its own module doc states that
chains "persist for the lifetime of the process" with no TTL and no LRU
bound. That is an unbounded map in a long-running service — a leak before
it is a durability gap — and attribution windows run 30 to 90 days, so
the state is genuinely long-lived rather than merely un-expired. Losing
it silently changes attribution results rather than costing a bounded
window.

Maturity tier assumed: **SMB**, per [0001]. Redis and PostgreSQL are both
already in the stack; this decision adds no new infrastructure.

## Decision Drivers

- State whose lifetime is a domain rule should be stored somewhere that
  expresses that rule, not somewhere that needs a sweeper to fake it.
- Unbounded in-process growth is a defect independent of durability.
- Delivery is at-least-once and processors must be idempotent; a store
  that can participate in the consumer's checkpoint transaction is
  strictly stronger than one that cannot.
- Reuse an established in-repo pattern over introducing a second one.
- Replayability within the retention window is a primary architectural
  constraint ([0001]) — a store whose loss is replay-recoverable can
  accept weaker durability than one whose loss is not.

## Considered Options

- Option A — Redis for both stores
- Option B — PostgreSQL for both stores
- Option C — Redis for the sessionizer, PostgreSQL for the attribution
  engine, split by state shape
- Option D — Keep both in memory; rely on replay after any restart

## Decision Outcome

Chosen: **Option C**.

The sessionizer moves to Redis. Its state is TTL-shaped, so Redis key
expiry *is* the inactivity rule rather than an approximation of it, and
`gcExpired()` retires rather than being promoted to a timer. Read-modify-
write on a hot key per event is the access pattern Redis is for. Weaker
durability is acceptable here specifically because the output is
deterministic and replayable.

The attribution engine moves to PostgreSQL, following the repository
pattern `processors/identity-resolver/v1/src/repository.ts` already
established: an interface the runtime depends on, a Kysely adapter in
production, an in-memory adapter for tests. This bounds the state, makes
chains queryable for the attribution debugging that operators currently
cannot do at all, and opens the door to committing chain updates in the
same transaction as the consumer checkpoint — the strongest guarantee
available to any Polaris consumer, per `03-rabbitmq-streams.md`.

Rejecting a single store for both is the substance of this ADR. Uniformity
would be the easier thing to defend in review and the wrong thing for at
least one of the two processors: Redis for attribution means a 90-day TTL
on an unbounded hot keyspace, and PostgreSQL for the sessionizer means a
row write per event on the hottest path in the system to hold state that
is designed to be discarded.

## Consequences

- Positive: both processors survive restarts. The sessionizer stops
  losing open windows; the attribution engine stops leaking.
- Positive: `gcExpired()` and the timer-sweep it anticipated are no
  longer needed — expiry becomes the store's job.
- Positive: attribution chains become inspectable, which is a capability
  operators do not have today.
- Negative: both store interfaces become asynchronous, which ripples into
  each runtime's handler. Unavoidable for any external store.
- Negative: the sessionizer gains a Redis dependency on its hot path.
  A Redis outage stalls it rather than degrading it — the correct
  failure mode for an at-least-once consumer, but a new stall source.
- Negative: two state technologies to operate rather than one. Accepted
  deliberately; see the rejection above.
- Follow-up work: per-processor state metrics, and deciding whether the
  attribution engine should commit chain writes in the consumer's
  checkpoint transaction (possible after this change, not part of it).
- Conditions that would prompt a revisit: attribution chain volume
  outgrowing single-node PostgreSQL, or session state acquiring a
  requirement that outlives the inactivity window — either would move
  that processor to the other store.

## Pros and Cons of the Options

### Option A — Redis for both

- Good: one state technology; one operational story; TTL native.
- Good: fastest per-event path for both.
- Bad: attribution chains have no natural TTL. A 30–90 day expiry on an
  unbounded keyspace is a memory-sizing problem moved from the process to
  Redis, not solved.
- Bad: no transactional relationship with the consumer checkpoint.
- Bad: chains stay un-queryable, so attribution stays undebuggable.

### Option B — PostgreSQL for both

- Good: one state technology; durable; queryable; checkpoint-transactional.
- Good: reuses identity-resolver's existing repository pattern for both.
- Bad: a row write per event for session state that exists to be thrown
  away, on the highest-volume path in the platform.
- Bad: expiry becomes a scheduled DELETE — reintroducing exactly the
  sweeper `gcExpired()` was written for and never needed.

### Option C — Split by state shape (chosen)

- Good: each store's lifetime rule is expressed by the store itself.
- Good: no sweeper anywhere.
- Good: attribution gains durability, bounds, and queryability together.
- Bad: two technologies, two adapters, two failure modes to document.

### Option D — Keep both in memory

- Good: no change; no new dependency.
- Bad: does not address the unbounded map, which is a defect regardless
  of the durability question.
- Bad: "replay after restart" is not an operational procedure anyone
  runs per pod restart.

[0001]: 0001-platform-architecture-ledger.md
