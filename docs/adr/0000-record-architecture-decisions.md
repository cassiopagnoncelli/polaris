---
id: 0000
title: Record architecture decisions
status: Accepted
date: 2026-05-15
deciders: architect
supersedes:
superseded_by:
related_card:
---

## Context and Problem Statement

This project will accumulate architectural decisions — choices about runtime, storage, interfaces, deployment, observability, and the trade-offs behind each. Without a durable record, the *why* is lost the moment the original conversation ends, and successors (human or agent) re-litigate the same choice with less information than the people who made it the first time.

## Decision Drivers

- Decisions must survive personnel and tooling change.
- The record must be navigable offline, with no external service in the loop.
- The format must scale from a one-developer homelab to an enterprise audit context without a rewrite.

## Considered Options

- ADRs as Markdown files in version control, MADR format
- A wiki page per decision
- Decisions captured only in PR descriptions

## Decision Outcome

Chosen: **ADRs as Markdown files in version control, MADR format.**

ADRs live under `agents/architect/adr/`, one decision per file, filenames `NNNN-kebab-title.md`. This entry is `0000`; subsequent ADRs increment from `0001`. The MADR template lives at `agents/architect/adr/TEMPLATE.md`, and the navigable index lives at `agents/architect/adr/README.md`.

## Consequences

- Positive: durable, offline-readable, version-controlled, reviewable in PRs alongside the code the decision governs.
- Positive: a numbered series makes it trivial to cite a decision (e.g. "see ADR-0007") from code, pm cards, or chat.
- Negative: requires discipline — the architect must actually open an ADR when a load-bearing choice is made. There is no enforcement layer.
- Follow-up: maintain `agents/architect/adr/README.md` as the navigable index, updated in the same commit as any status change.
- Revisit if: an alternative store (a generated catalogue, a managed ADR tool) becomes clearly worth the migration cost.

## Pros and Cons of the Options

### ADRs as Markdown in version control

- Good: lives next to the code; diffable; reviewable in PRs
- Good: works offline; no external dependency or auth boundary
- Bad: requires discipline; no enforcement layer

### Wiki page per decision

- Good: easy to write; supports rich formatting
- Bad: drifts from code; usually requires separate auth and network
- Bad: weak history and weak review semantics compared to git

### PR descriptions only

- Good: zero overhead at decision time
- Bad: decisions are scattered across hundreds of PRs and effectively unfindable later
- Bad: no canonical "current state" view of the architecture
