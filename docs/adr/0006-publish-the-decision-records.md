---
id: 0006
title: Publish the decision records
status: Accepted
date: 2026-08-19
deciders: architect
supersedes:
superseded_by:
related_card:
---

## Context and Problem Statement

ADR-0000 put the records under `agents/architect/adr/`. `agents/` is
gitignored — it is an agent workspace, not part of the repository — so the
six accepted ADRs, 626 lines recording the load-bearing choices of the
entire platform, existed only on machines that happened to have that
workspace.

`docs/README.md` linked four of them from the documentation reading order.
Anyone who cloned Polaris and followed those links got nothing. The links
were live for months and nobody noticed, because everyone who read the
index had the workspace.

A documentation-link check found it, and only after that check stopped
asking `existsSync` — which answers about the author's disk — and started
asking git, which answers about the repository. The first version of the
check passed locally and failed in CI on exactly these six links.

So the problem is not a broken link. It is that the record of why this
platform is shaped the way it is was not in the platform's repository.
ADR-0000's own stated driver was "decisions must survive personnel and
tooling change"; a location that depends on having the tooling installed
is the one place that driver cannot hold.

## Decision Drivers

- A decision record that a reader of the repository cannot open is not
  serving the purpose ADR-0000 established.
- The reading order in `docs/README.md` should be followable by anyone who
  clones the repository.
- Exactly one copy. Two homes for one record is the defect this repository
  keeps finding in its own code; it should not be introduced here.
- The architect agent must keep working, and its workspace is installed
  and updated by tooling this decision does not control.

## Considered Options

- Move the records to `docs/adr/`
- Leave them in `agents/` and drop the four links from the reading order
- Copy them into `docs/adr/` and keep the originals

## Decision Outcome

Chosen: **move the records to `docs/adr/`.**

An architecture decision record is documentation of exactly the kind
`docs/` exists to hold, and this repository is where the architecture it
describes lives. `docs/README.md` links them again, as links rather than
as the bare paths it briefly listed while they were unreachable.

`agents/architect/adr` is a symlink to `../../docs/adr`, so the path the
architect agent writes into still resolves and there is still exactly one
copy on disk. The copy-and-keep-both option was tried first and reverted
within a minute: it is the one-fact-in-two-places failure that most of the
2026-08-19 conformance audit consisted of.

`docs/adr/` is skipped by `scripts/lint-retired-paths.mjs`, on the same
reasoning as `db/migrations/`. An accepted ADR records what was true when
it was accepted — ADR-0005 names `processors/sessionizer/v1/src/store.ts`
because that is where the file was — and editing one to satisfy a lint
would falsify the record the file exists to keep.

## Consequences

- Positive: the reading order is followable by anyone with a clone.
- Positive: ADRs are reviewable in PRs alongside the code they govern,
  which ADR-0000 listed as a driver and the previous location prevented.
- Negative: **this contradicts the architect workspace's own contract.**
  `agents/architect/AGENT.md` says ADRs are "records, not scaffolding:
  never shipped". That line is now false, and it lives in a directory
  installed and updated by agent tooling, so editing it here may not
  survive the next install. Reconciling the two is the follow-up below and
  belongs to whoever owns the workspace, not to this ADR.
- Negative: the records are now public, because this repository is public.
  They were read for anything unpublishable before the move — no
  credentials, no external URLs, no personal identifiers — but "who may
  read our architecture decisions" is now answered by the repository's
  visibility rather than by a `.gitignore` entry.
- Follow-up, done: `agents/architect/AGENT.md` and its README now say the
  records live in `docs/adr/` with a symlink here, and narrow the "never
  shipped" claim to what it was always about — the FRAMEWORK does not ship
  records in either direction, which is untouched by where one project
  keeps its own. Those files are installer-managed, so the edit may not
  survive the next install; this ADR is the durable copy of the reasoning.
- Follow-up: `README.md` in this directory indexed only ADR-0000 while
  0001 through 0005 existed. Fixed in this commit; the index is
  hand-maintained and drifted the moment a second ADR was written.
- Revisit if: the workspace tooling reclaims `agents/architect/adr/`, or a
  decision needs to be recorded that genuinely should not be public.

## Pros and Cons of the Options

### Move to `docs/adr/`

- Good: one copy, in the repository the decisions are about
- Good: the reading order works for every reader
- Bad: contradicts the agent workspace's stated contract
- Bad: makes the records public, which is a decision in itself

### Leave in `agents/` and drop the links

- Good: no publishing decision, no contract to reconcile
- Bad: the documentation stops admitting the decisions exist
- Bad: the driver ADR-0000 named — surviving tooling change — stays unmet

### Copy, keeping both

- Good: nothing breaks anywhere
- Bad: two homes for one record, which is precisely the defect class the
  conformance audit spent two days removing from this repository
