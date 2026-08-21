---
id: 0007
title: Restructure the repository around six object kinds
status: Accepted
date: 2026-08-20
deciders: architect
supersedes:
superseded_by:
related_card: U2ED, B2YJ, WNGW6
---

## Context and Problem Statement

The R-programme move (`f9ae3d0`) settled the taxonomy for runnables:
`{sync,async}/{stage}/{name}/{version}`, the tree as the pipeline map. It
left three regions unsettled, and a fourth question was raised by holding
the tree against the Segment product surface it is meant to reach.

First, `packages/` is a flat namespace of twenty-four packages, twenty of
them under a `shared-` prefix. `shared-policy`, `shared-schemas`,
`shared-transport` and `shared-control-plane` are four different
architectural layers wearing the same badge; the prefix means "not yet
categorised". This is the one place the tree-encodes-taxonomy principle
was never applied.

Second, `catalog/` names declared content — event schemas, trait and
audience definitions, policy — with the word the industry uses for a
connector registry. Segment's own Catalog is its destination browser.
Every future reader, and every agent navigating by name, is invited to
assume the inversion.

Third, domain physics is trapped inside versioned runtime shells.
Identity resolution — graph, bounds, connected components, merge
semantics — is smeared across `sync/identity/resolver/v1/src` and
`shared-processor`'s identity modules. Version directories exist as
replay-determinism contracts; the more version-invariant logic lives
inside a `vN`, the more every version bump forks a world instead of a
delta, and the platform's own evidence (`sessionizer/v1` beside `v2`)
shows the cost is recurring, not hypothetical.

Fourth, Segment-parity capabilities that are accepted scope — activation,
linked audiences, profiles sync, cloud sources, privacy — need named
homes that do not turn the tree into a roadmap of empty directories.

A product-surface tree was considered and is recorded as Option A: it is
Segment's information architecture transcribed into directories, designed
for buyers navigating features rather than maintainers navigating
execution. Its `apps/worker` ("one deployable, N consumers") would
reverse the R programme; its nine-directory `control-api` presumes
configuration lives in a database behind an API rather than in git; it
contains no SDKs at all.

Maturity tier assumed: **SMB**, per [0001]. Reference model: the Segment
product surface, treated as a scope contract — capability may be
sequenced, never silently dropped.

## Decision Drivers

- The tree is documentation and the retrieval index; placement must not
  be tribal knowledge, and agents navigate by name.
- A migration here is feasible in proportion to how completely it can be
  restated as a gate — the `f9ae3d0` docs-drift aftermath and
  `lint-retired-paths.mjs` are the recorded lesson.
- Replay determinism is the platform's correctness property; version
  boundaries are contracts, not clutter.
- Segment-likeness is measured at the margin: the cost of the fortieth
  connector, not the fifth.
- pnpm resolves imports by package name, so location and identity are
  decoupled — directory moves are cheap; references and category churn
  are the real costs.
- Declared configuration reviewed in PRs (git as control plane) is
  stronger change management for a single-org platform than an admin API.

## Considered Options

- Option A — Product-surface tree: adopt the Segment-shaped
  `apps/{gateway,control-api,worker}` + `libs/` layout wholesale.
- Option B — Status quo: keep `packages/shared-*`, `catalog/`, and logic
  in runtime shells.
- Option C — Six-kind taxonomy: each kind of object gets the axis its
  dominant query pattern wants; three enforced laws carry the structure.

## Decision Outcome

Chosen: **Option C**. The root encodes six kinds, and kind chooses the
axis. Nothing may belong to two kinds.

| Root | Kind | Axis |
|------|------|------|
| `apps/` | edges and planes (services that are not pipeline stages) | role |
| `sdks/` | client artifacts shipped into other codebases | platform |
| `sync/`, `async/` | runnables | topology: `{stage}/{unit}/{version}` |
| `connectors/` | vendor adapters — uniform port implementations, not deployables | family: `{destinations,sources,warehouses}/{vendor}/{version}` |
| `libs/` | domain meaning — pure logic with no runtime identity | domain |
| `definitions/` | declared intent, in git — the control plane of record | contract type |

The meta ring (`db/`, `infra/`, `blueprints/`, `docs/`, `tests/`,
`scripts/`, `bin/`) is unchanged, except that storage DDL unifies under
`db/{postgres,clickhouse}` and `sql/` retires.

### Target tree

Markers: `✓` exists, `◐` partial, `←` absorbs existing packages, `→`
refactor of existing code, `○` future home — named here and in the
delivery plan, created in the repository only when its first real file
lands.

```
apps/
  ingester-api/                    # ✓ write edge
  control-plane-api/               # ✓ operations only: breakers, replay triggers,
                                   #   suppression, audit — never config CRUD
  profile-api/                     # ○ read edge for profiles/traits
  functions-runtime/               # ○ isolated sandbox for user-supplied functions
  polaris-cli/                     # ✓ operator surface

sdks/
  web/  node/                      # ← packages/web-sdk, packages/node-sdk
                                   #   device-mode destinations live here as plugins

sync/                              # the spine — {stage}/{unit}/{version}
  identity/resolver/v1             # ✓ thin shell; physics in libs/identity
  enrichment/{runtime,geoip,traits}/v1     # ✓
  destinations/
    delivery/v1                    # → engine loading connectors/destinations/*
    braze/… webhook-sink/v1        # ✓ absorbed as vendor count grows

async/
  computation/
    sessionizer/v1 v2              # ✓
    attribution-engine/v3          # ✓
    audiences/v1  traits/v1        # ✓ evaluator runtimes; logic in libs/engage
    linked-audiences/v1            # ○ data-graph predicates -> warehouse SQL -> membership
  journeys/orchestrator/v1         # ✓ machine/instance logic in libs/engage/journeys
  merges/merge-worker/v1           # ✓ heavy identity path: components, merge, unmerge
  activation/audience-sync/v1      # ◐ membership deltas -> vendor list ops via connectors
  warehouse/{clickhouse-sink,archiver}/v1  # ✓
  profiles-sync/materializer/v1    # ○ id_graph / external_id_mapping / profile_traits
  reverse-etl/runner/v1            # ✓
  sources/puller/v1                # ○ scheduler+executor loading connectors/sources/*
  privacy/deletion-worker/v1       # ○ sweeps stores, forwards to destinations, scrubs archive

connectors/
  destinations/{braze,ga4,meta-capi,tiktok,webhook-sink}/v1   # → map()/deliver() + list ops
  sources/<vendor>/v1              # ○
  warehouses/clickhouse/v1 …       # → / ○

libs/
  spec/                            # ← shared-schemas — no @polaris import
  contracts/                       # inter-stage shapes, job payloads
  tenancy/                         # domain ← shared-project-config,
                                   #   project-config-schemas, shared-control-plane
  auth/                            # infrastructure ← polaris-idp
  identity/{graph,rules,components,merge}/   # the decomposed subsystem
  profiles/                        # profile aggregate, external IDs, trait model
  governance/                      # ← shared-policy + violation vocabulary
  engage/{audiences,journeys,activation}/
  data-graph/                      # ○ entities, relationships, linked-audience compiler
  delivery/                        # ← destination-host, shared-destinations, -normalize + ports
  warehouse/                       # RETL extract/diff/map/load; profiles-sync materialization
  archive/{writer,replay}/         # ← shared-archive, shared-replay
  privacy/                         # ○ suppression, deletion, selective-sync
  pipeline/                        # infrastructure ← shared-processor
  bus/                             # ← shared-transport
  persistence/{postgres,clickhouse,control-plane}/
  observability/{logger,metrics}/
  runtime/{service-bootstrap,config,environments,secrets}/

definitions/                       # ← catalog/ — declared intent, in git
  projects/ sources/ events/ traits/ audiences/ journeys/ policy/ reverse-etl/
  data-graph/                      # ○

db/{postgres,clickhouse}/          # ← db/migrations + sql/clickhouse
```

### The three laws

1. **Libraries group by domain; "shared" is not a domain.** Enforced by a
   name-path congruence lint (`libs/<domain>[/<name>]` ↔
   `@polaris/<domain>[-<name>]`, allowlisted exceptions carry reasons)
   and retired-path entries for `packages/` and `catalog/`.
2. **The kernel imports no Polaris package.** `libs/spec` sits at the
   bottom of the Polaris graph, not of the dependency graph; layering is
   enforced by an import-direction lint: contracts import spec; domain
   libs import spec, contracts and each other, never infrastructure;
   infrastructure libs never import domain; units compose both; nothing
   imports a unit; connectors import spec and their port. (As first
   written this law said "the kernel imports nothing" — amended
   2026-08-21, below.)
3. **A version directory contains only what the version changed.**
   Version-invariant physics lives in `libs/`; `vN` trends toward
   manifest plus wiring. The counterweight is the determinism discipline:
   a semantic change to an extracted library takes a new entrypoint or
   major version, never an edit in place, because `resolver/vN` replay
   output is a correctness contract (unmerge is replay-rebuild).

### Amendments

**2026-08-21 — the second law, made precise (`WNGW6`).** The
import-direction lint (`LYAFL`) shipped enforcing what this record
actually said and refusing to guess the rest. It left two questions,
and both are answered here.

*The kernel law is about the Polaris graph.* `libs/spec` expresses
every event, envelope and catalog type as a `zod` schema and parses the
`definitions/` tree with `yaml`. Read literally, "imports nothing" made
those two edges debt, and a debt list is an invitation: somebody would
eventually spend a week hand-rolling a validator to pay off something
that was never owed. A schema kernel importing the notation it
expresses schemas in is design. So the law is restated as "the kernel
imports no Polaris package", and `zod` and `yaml` move from the
burn-down baseline to a named allow-list in
`scripts/lint-import-direction.mjs`, each with its reason at the entry.

The allow-list rather than a blanket third-party exemption is the other
half of the ruling, and it costs one line per package: `@polaris/spec ->
axios` must still stop a build, because a schema kernel making HTTP
calls is what this law is for. The Polaris half has no exceptions at
all — not the allow-list, not the type-only devDependency carve-out —
so `@polaris/spec -> @polaris/runtime-environments` is unaffected and
stays debt. That edge is the law's actual subject.

*The three unplaced libraries are placed.* `libs/tenancy` is **domain**:
which project, which environment, which write key is declared intent,
and the tree lists it beside `contracts` rather than in the shells.
`libs/pipeline` is **infrastructure**: manifests, run lifecycle, the DLQ
ledger and transport hooks are the machinery that carries meaning, not
the meaning, and the tree above already groups it with the
infrastructure block — only the lint's enumeration left it out.
`libs/auth` is **infrastructure**: a client of an external identity
provider, whose sole dependency is `jose`. The matrix now places every
library and the lint's `UNCLASSIFIED` set is empty; the mechanism stays
for a library that genuinely cannot be placed yet, and an entry costs a
written reason.

Classifying tenancy as domain is the expensive answer and is taken
anyway. It banks six edges of debt — `tenancy-project-config` and
`tenancy-control-plane` reaching for `persistence-postgres`,
`observability-logger`, `runtime-environments` and `runtime-secrets`,
and `persistence-control-plane` reaching back for
`tenancy-control-plane`'s validation and masking rules. Calling tenancy
infrastructure would have banked one edge instead of six by making the
other five legal by definition, which is an argument for the
classification and not against it: the edges are real either way, and
only one of the two answers writes them down.

### Boundary rules

- **Git for declarations, API for operations.** Intent — schemas,
  mappings, audiences, journeys, models, projects — is a file in
  `definitions/`. State-of-now — an open breaker, a running replay, a
  suppression entry — is `control-plane-api`. The thin `routes/` in
  control-plane-api is the intended end state, not immaturity.
- **The registry decouples existence from deployment.** `connectors/`
  records which vendors exist; how many deployables serve them is an
  operational decision that can change without the tree changing.
  Connector versions protect audit and canary, not replay — delivery is
  effectful and replay stops at the effect boundary.
- **The tree is a ledger.** `○` homes live in this record and on the pm
  board until their first real file; empty directories are never
  committed. Deferral is sequencing, never scope removal.

## Consequences

- Positive: the domain axis exists for the code that has no topology;
  identity, engage and delivery logic become unit-testable outside
  broker/DB shells; version bumps price the delta, not the world; the
  connector registry makes the marginal vendor cheap; `catalog/` stops
  teaching the wrong meaning; SDKs sit in the tier ADR-0003 already
  treats them as.
- Negative: a reference sweep of roughly 132 tracked files for
  `catalog/` and several hundred for `packages/`; a two-step transition
  (directories move first under dual workspace globs, names chase them
  once); reviewers must learn six kinds and three laws.
- Follow-up work — programme T, filed 2026-08-20, execution gated on the
  architect's explicit go:
  - Group `U2ED` (wave T0, mechanical): `2XH2V` scaffolding globs,
    `HBXPO` platform libs move, `BCYQ6` domain libs move, `ZXBDY` SDK
    promotion, `0DIPB` catalog→definitions, `TI9XZ` DDL unification,
    `IJ4NN` package renames + congruence gate + `packages/` retirement.
  - Group `B2YJ` (wave T1, extractions): `LYAFL` import-direction lint,
    `J41BM` libs/identity + libs/profiles carve-out, `Q7COB` libs/engage
    carve-out, `P9J7X` connectors registry + delivery ports.
  - `○` homes (activation, linked audiences, data-graph, profiles-sync,
    sources, privacy, profile-api, functions-runtime) are carried by the
    delivery roadmap, not by this programme.
- Divergence allowance: mostly-but-not-exactly is acceptable where
  mechanics demand it — persistence drivers stay separate packages so
  `lint-clickhouse-imports` keeps its boundary; delivery deployment
  granularity stays per-vendor until pooling is justified; congruence
  exceptions are allowlisted with reasons.
- Conditions that would prompt a revisit: the congruence or
  import-direction lints fighting legitimate structure more than once a
  quarter; the connector registry failing its first real test (vendor
  six); a second warehouse engine arriving with needs
  `db/{postgres,clickhouse}` cannot express.

## Pros and Cons of the Options

### Option A — product-surface tree

- Good: supplies the domain vocabulary (`identity`, `engage`,
  `governance`) this decision adopts for `libs/`; names the sandbox
  isolation principle for user code.
- Bad: `apps/worker` reverses the R programme's version-per-unit replay
  contract with no new evidence; `control-api` presumes config-as-rows
  where Polaris deliberately runs config-as-git; no SDKs anywhere;
  `catalog` naming inverted; half its leaves are vacancies that would
  make `ls` lie.

### Option B — status quo

- Good: zero churn.
- Bad: `shared-*` stays a failed taxonomy that grows worse with every
  package; extraction never happens so every version bump forks whole
  units; `catalog/` keeps teaching the wrong meaning; no home for the
  Segment-parity capabilities that are already accepted scope.

### Option C — six-kind taxonomy (chosen)

- Good: each axis serves the query pattern that dominates its kind;
  moves are nearly free under name-based resolution; every move ships
  with the gate that makes it permanent, in the repository's native
  idiom.
- Bad: six kinds and three laws to learn; a transition window with dual
  globs; the rename sweep is real work even when mechanical.
