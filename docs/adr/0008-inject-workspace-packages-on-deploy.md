---
id: 0008
title: Inject workspace packages into the deploy tree
status: Accepted
date: 2026-08-20
deciders: architect
supersedes:
superseded_by:
related_card: NV933
---

## Context and Problem Statement

Every Polaris image is built the same way. A builder stage installs the whole
workspace, compiles one package, and assembles a production tree:

```dockerfile
RUN pnpm --filter "@polaris/<unit>" deploy --prod /deploy
```

and a runtime stage takes that tree and nothing else:

```dockerfile
COPY --from=builder --chown=polaris:polaris /deploy /app
```

From pnpm v10 that first instruction refuses to run:

```
[ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE] By default, starting from pnpm v10, we
only deploy from workspaces that have "inject-workspace-packages=true" set
```

The repository pins `pnpm@11.21.0` in `packageManager`, so this affects all
seventeen Dockerfiles — fourteen pipeline units and three apps — and the
`infra/docker/base.Dockerfile` template they are copied from. Every image in the platform has been unbuildable since
the runtime crossed v10, and nothing reported it: no CI job builds an image,
so the failure surfaced three separate times as a side effect of unrelated
cards (`YQVZG`, `HBXPO`, and this one) rather than as a red build.

Maturity tier assumed: **SMB**, per [0001]. The decision is about what ships
inside a container image, so it is load-bearing for deployment and cheap to
reverse only until images are published from it.

The error is easy to silence, and that is the trap. pnpm names a flag in the
message, and applying the flag makes the build go green while leaving
unanswered the question the error is really asking: **what should `/deploy`
contain — links to the workspace, or the workspace's files?** For a tree whose
entire purpose is to be copied out of the filesystem that defines it, that is
not a configuration preference.

## Decision Drivers

- `/deploy` is consumed by `COPY --from=builder`, which copies a directory —
  a symlink out of that directory does not survive the copy, because its
  target is not part of what is copied.
- The runtime stage has no pnpm, no workspace, and no `/workspace` directory;
  nothing there can resolve a workspace link after the fact.
- The version of pnpm is written in exactly one place (`packageManager`), and
  every additional copy of it in this repository has gone stale — three times
  so far.
- The images are the platform's deliverable; a mode pnpm documents as
  transitional is a poor foundation for one.
- Nothing in CI builds an image, so whatever is chosen needs a check that
  fails in the gate rather than at the next `docker build`.

## Considered Options

- Option A — `pnpm deploy --legacy` on all eighteen Dockerfiles
- Option B — `injectWorkspacePackages: true` in `pnpm-workspace.yaml`
- Option C — `force-legacy-deploy: true` in the workspace file

## Decision Outcome

Chosen: **Option B**, `injectWorkspacePackages: true` in
`pnpm-workspace.yaml`.

Injection is the mode these images need, independently of it being the mode
pnpm is moving toward. With it, a workspace dependency inside `/deploy`
resolves to real files under `/deploy/node_modules/.pnpm/`; without it, it is
a symlink into `/workspace`, which is a path that exists only in the builder
stage. `/deploy` becomes closed under the copy that consumes it, which is the
property a container image requires and the one the Dockerfiles have always
assumed — `infra/docker/README.md` has described the tree as self-contained
since it was written.

Option A produces the same green build and preserves the wrong property.
Option C is Option A moved into a config file, where it applies to every
future `deploy` invocation without appearing at any of them.

**The pnpm version is aligned in the same change.** `base.Dockerfile`
installed `pnpm@10.30.0` while `packageManager` said `11.21.0`. `719a9d2`
removed that pin from the seventeen Dockerfiles and missed the template
they are copied from, leaving the canonical reference a major version
behind the files it governs. It is unpinned here the same way: pnpm reads
`packageManager` and self-manages, so the version has one home. The two halves
belong in one decision because the deploy mode is only a question at all on
v10 and later — pinning a v10 image and choosing a v11 deploy mode would be a
third latent trap of the kind this record exists to remove.

## Consequences

- Positive: `/deploy` is genuinely self-contained. Verified rather than
  assumed — after the change, every symlink in a deployed tree resolves to a
  target inside that tree.
- Positive: one home for the pnpm version, and `base.Dockerfile` is once
  again a template that matches what it templates.
- Positive: `scripts/lint-docker-deploy.mjs` fails the gate if injection is
  turned off or a Dockerfile re-pins a version, so the next regression is
  caught by `pnpm lint` rather than by a docker build nobody runs.
- Negative: what ships in the image changes. Workspace dependencies are
  copies, not links, so a unit's image now carries its own copy of each
  `@polaris/*` dependency. Image size grows by the size of the workspace deps
  in the graph; deduplication across services was never available anyway,
  since each image ships its own tree.
- Negative, and CORRECTED ON 2026-08-21 by card `PHYFV`: this bullet asserted
  the opposite, and being able to read it and still be wrong is what cost two
  workers a diagnostic cycle each. It said the development tree was unchanged
  — that after a clean install the `@polaris/*` entries under a package's
  `node_modules` are all still plain symlinks to their sources, and that
  injection materialises only when `pnpm deploy` assembles a tree.

  It is true of most of the graph and false exactly where it matters.
  `pnpm install` injects in the development tree too, for the packages
  reachable through an injected dependency — eleven of them here, materialised
  as hard-linked snapshots under `node_modules/.pnpm/<pkg>@file+<path>/`, with
  each dependent pointed at the snapshot instead of at the source.

  A snapshot is taken at install time and is never updated afterwards. On a
  fresh worktree that is BEFORE anything is built, so the copy carries no
  `dist/`; building the source later does not reach the copy; and `tsc`,
  following the copy's own `"types": "./dist/index.d.ts"`, reports
  `TS2307: Cannot find module '@polaris/<x>'` from a package the change never
  touched. Editing a library is still visible to its dependents without
  reinstalling wherever the link is a symlink. Through an injected copy it is
  not visible at all.
- Negative: turning the setting on over an EXISTING `node_modules` leaves a
  half-migrated tree — pnpm writes the injected virtual-store entry without
  populating it, and the dangling link presents as `TS2307: cannot find module
  @polaris/<x>` from a package that plainly has one. `pnpm install` reports
  "Already up to date" and does not repair it.

  This bullet ended "A clean install does", and CARD `PHYFV` FOUND THAT WRONG
  TOO, on 2026-08-21. A clean install is not sufficient and is not even the
  operative half: `rm -rf node_modules` at the root does remove the virtual
  store, but the install that follows re-snapshots sources that have not been
  built yet and rebuilds the identical broken tree. It is not staleness. It is
  ORDER — the copy is taken before the output it is supposed to carry exists,
  and that is true of a first install as much as of a migrated one. What a
  clean install has to include under injection is the per-package trees and
  the virtual store, and what pnpm consults to decide the workspace needs no
  re-linking is `node_modules/.pnpm-workspace-state-v1.json`.

  So the repair is: build the injected sources, remove that state file,
  install again. One command does it —
  `node scripts/sync-injected-workspace-copies.mjs` — and `.pm/worktree-setup`
  runs it in every worktree pm creates, so the cost of this decision is paid
  once in provisioning rather than per worker, per worktree, as a phantom
  error in somebody else's package.

  Provisioning reaches only the trees created after it, which card `X96DD`
  found the expensive way: group `31QH`'s worktree was cut four cards before
  the hook learned to sync, so `pm g land` ran `pnpm verify` in a tree the fix
  had never touched and failed on the same `TS2307`, in `libs/delivery/port`,
  a package none of its cards had gone near. `pnpm verify` therefore opens
  with `node scripts/sync-injected-workspace-copies.mjs --check`. It is a
  precondition rather than a gate — it reports and does not repair, because a
  gate that mutates the tree it is judging hides the drift instead of
  reporting it — and it costs milliseconds against the diagnostic cycle a
  phantom `TS2307` costs.
- Negative: the setting is recorded in `pnpm-lock.yaml`'s `settings` block, so
  turning it off is a lockfile change and turning it on is one too.
- Negative: injection interacts with `workspace:*` graph edits — a package
  that changes its dependencies changes what its image carries. Landed after
  `IJ4NN` closed the T-programme's package moves, so the graph was settled
  first.
- Follow-up work: none. CI wiring that would build an image is `5OV81` and is
  deliberately out of scope here.
- Conditions that would prompt a revisit: image size becoming a constraint
  (the deploy tree is the place to look first), or pnpm changing the default
  again — in which case the check in `scripts/lint-docker-deploy.mjs` is the
  thing to read, since it encodes what the images actually require rather than
  what the current pnpm happens to demand.

## Pros and Cons of the Options

### Option A — `pnpm deploy --legacy`

- Good: smallest diff that clears the error; `/deploy` keeps exactly the shape
  the images were built against, so nothing about the runtime changes.
- Good: no change to image contents, so no size regression.
- Bad: preserves symlinks into `/workspace`, i.e. the property that makes
  `/deploy` depend on a filesystem the runtime stage does not have.
- Bad: pnpm documents `--legacy` as transitional; adopting it schedules this
  same decision for a later date, with images published in the meantime.
- Bad: eighteen copies of the flag, which is the duplication shape that
  produced the stale pnpm pin in the first place.

### Option B — `injectWorkspacePackages: true`

- Good: `/deploy` is closed under the copy that consumes it.
- Good: one line, in the file that already configures the workspace; no
  per-Dockerfile change and so nothing to keep aligned across eighteen files.
- Good: the direction pnpm is moving, so it does not expire.
- Bad: changes what ships — real files rather than links — which is a
  deliberate change to the artifact and the reason this record exists.
- Bad: the key is camelCase here and kebab-case in `.npmrc`, and pnpm's error
  message quotes the `.npmrc` spelling. The wrong spelling is valid YAML,
  silently ignored, and fails identically. Guarded by the check.

### Option C — `force-legacy-deploy: true`

- Good: clears the error in one line, like Option B.
- Bad: Option A's semantics with Option A's drawbacks, and less visible —
  the deploy commands no longer say which mode they run in.
- Bad: names itself `force` and `legacy`, which is the tool warning that this
  is an escape hatch rather than a setting.

[0001]: 0001-platform-architecture-ledger.md
