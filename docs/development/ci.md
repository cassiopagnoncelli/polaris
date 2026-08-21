# CI

Polaris uses GitHub Actions. Three workflow files cover the full quality gate
set documented in
[`09-engineering-standards.md` "CI Quality Gates"](../architecture/09-engineering-standards.md#ci-quality-gates)
plus the ClickHouse access enforcement from
[`07-clickhouse.md` "Access Control"](../architecture/07-clickhouse.md#access-control):

| Workflow                                    | Trigger                                              | Purpose                                                                                    |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)           | every PR and push to `main`, manual dispatch         | typecheck, lint (Biome + ClickHouse import rule + raw-NUL check), format check, tests, build, migration smoke |
| [`.github/workflows/integration.yml`](../../.github/workflows/integration.yml) | schedule (06:00 UTC), manual dispatch, `integration` PR label | Docker-backed checks against Postgres, Redis, RabbitMQ, ClickHouse                         |
| [`.github/workflows/images.yml`](../../.github/workflows/images.yml)           | every PR and push to `main` (representative set); schedule (04:00 UTC) for all eighteen | builds production images, so an image that cannot build fails a gate                        |

The integration workflow is opt-in on PRs because the service matrix is slow
and still stabilising. Once the vertical-slice smoke test is reliable
(see `P5-001`),
the per-service jobs may graduate to required gates.


## Integration tests (broker + database)

```bash
pnpm test:integration
```

Runs `tests/integration/` against a live RabbitMQ and PostgreSQL. Skipped
unless `POLARIS_INTEGRATION=1`, so the default `pnpm test` on every PR
stays hermetic and Docker-free; the integration workflow sets it after
`docker compose up`.

These cover the transport properties that fakes cannot express — prefetch
pushing messages ahead of the handler, a quorum queue's TTL firing, a
stream attaching at a timestamp, the checkpoint store's SQL. They exist
because four defects survived a green unit suite during the RabbitMQ
migration, one of which could only be reproduced against a real broker.

Locally:

```bash
docker compose up -d --wait postgres rabbitmq && pnpm db:migrate && pnpm test:integration
```

The suite declares its own test-scoped topology and deletes it afterwards,
so it is safe against a shared dev broker.

## Required PR gates

Every PR must pass these jobs in `ci.yml`:

- **`static-analysis`** — `pnpm build` (so each package's `dist/` exists for
  cross-package type resolution), then `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`.
- **`test`** — `pnpm build` followed by `pnpm test`. The root `test` script
  runs the workspace Vitest suite plus the repo-root `scripts/` test suite
  (see "ClickHouse import-restriction check" below). The workspace suite
  includes the event-catalog validation tests in
  [`@polaris/spec`](../../libs/spec/test/catalog.test.ts),
  so no dedicated catalog runner is needed.
- **`migrations`** — applies every file in `db/postgres/migrations/` against a
  disposable PostgreSQL 17 service via `pnpm db:migrate`. dbmate does not
  ship a true dry-run mode, so a smoke `up` is the lightest validation
  available.
- **`representative`** (in `images.yml`) — builds three of the eighteen
  images and then proves the build can fail. See
  [Image builds](#image-builds) for why it is three and not eighteen.

## ClickHouse import-restriction check

The architecture rejected a regex-based SQL lint (false positives on CTEs
and dynamic SQL, false negatives on aliased tables, decaying escape-hatch
comments — see
[07-clickhouse.md "Why grants instead of a lint"](../architecture/07-clickhouse.md#why-grants-instead-of-a-lint)).
Enforcement happens at two layers:

1. **Database grants** — the `polaris_service` role lacks `SELECT` on
   `analytics_raw`. Queries that go through the helper at the wrong
   profile cannot read the raw table at all.
2. **Workspace import rule** — only `libs/persistence/clickhouse/` may
   import `@clickhouse/client`. Any other workspace package that adds a
   static `import`, dynamic `import()`, or `require()` for that
   specifier fails the build.

The import rule is implemented in
[`scripts/lint-clickhouse-imports.mjs`](../../scripts/lint-clickhouse-imports.mjs).
It walks `apps/`, `libs/`, `sdks/`, `connectors/`, `sync/`, `async/`,
`definitions/` and `scripts/`, classifies each file's characters as code vs. comment
vs. string literal, and flags only real imports — comments that name
the package and prose in string literals do not trigger violations.

The script is wired into the root `pnpm lint` so it runs alongside Biome.
A targeted unit test in
[`scripts/__tests__/lint-clickhouse-imports.test.ts`](../../scripts/__tests__/lint-clickhouse-imports.test.ts)
seeds a temporary workspace tree with both allowed and disallowed callers
and asserts the violation set. The test runs as part of `pnpm test` via
`pnpm test:scripts`.

To verify a violation is caught locally:

```bash
# Drop a file outside libs/persistence/clickhouse/ that imports the client...
echo 'import "@clickhouse/client";' > apps/ingester-api/src/_oops.ts

pnpm lint:clickhouse-imports
# => exits 1, prints the offending file:line and a pointer to docs/architecture/07-clickhouse.md

# Clean up
rm apps/ingester-api/src/_oops.ts
```

## Raw-NUL-byte check

A text source file containing a raw NUL byte is *binary* to the tools we
read code with, and both of them fail quietly:

- **ripgrep skips binary files during recursive search.** It prints no
  warning and exits with the same status as a genuine no-match, so the
  file simply stops appearing in repo-wide results.
- **git renders the diff as `Bin 9450 -> 9851 bytes`** instead of
  reviewable text, so changes to it cannot be read in review.

This is not hypothetical. `apps/control-plane-api/src/admin/pages/processors.ts`
and `libs/pipeline/src/activation-gate.ts` each built a
composite `Map` key with a NUL separator written as the byte itself, and
both files were invisible to every `rg` search until it was noticed by
accident.

NUL as a *separator* is correct — it is the one character an identifier
cannot contain, so joined keys cannot collide. Writing it as the raw byte
is what breaks the tooling. The `\u0000` escape is the identical
string at runtime and leaves the file as plain text.

The check is implemented in
[`scripts/lint-nul-bytes.mjs`](../../scripts/lint-nul-bytes.mjs). It walks
`apps/`, `libs/`, `sdks/`, `connectors/`, `sync/`, `async/`, `definitions/`,
`scripts/`, `db/`, `docs/`, `tests/`, `agents/` and `bin/`, scanning an **allow-list** of text
extensions — so a genuinely binary file committed to the tree can never
fail the build. It is wired into the root `pnpm lint`, and
[`scripts/__tests__/lint-nul-bytes.test.ts`](../../scripts/__tests__/lint-nul-bytes.test.ts)
covers it via `pnpm test:scripts`.

To verify a violation is caught locally:

```bash
# printf expands \0 into a real NUL byte.
printf 'const k = "a\0b";\n' > libs/persistence/postgres/src/_oops.ts

pnpm lint:nul-bytes
# => exits 1, prints file:line and the byte offset of each NUL

# Clean up
rm libs/persistence/postgres/src/_oops.ts
```

## The declared-but-unread project-config key check

`pnpm lint:project-config-keys`, implemented in
[`scripts/lint-project-config-keys.mjs`](../../scripts/lint-project-config-keys.mjs).

Declaring a key in a component's `project-config.ts` is what creates operator
surface. The generator turns it into a JSON Schema artifact, the admin UI's
Variables panel renders a typed input for it, `polaris config set` accepts it,
`polaris config list` shows it, and `polaris config validate` reports on it —
all of which happen because the key is DECLARED. None of it requires the
component to READ the key.

So a declared-and-unread key is a control that looks live and is not: an
operator sets it, sees it stored, and nothing changes. meta-capi shipped
exactly that. `allow_replay` was declared and read by nothing, because replay
suppression runs in the destination runtime long before the deliverer the
config slice is handed to — and no type error or test could catch it, since the
key type-checked fine and the component's tests only covered what it read.

The check requires every key in a namespace's generated schema to appear by
name somewhere in the component's `src/` other than the declaration module
itself. Its `ALLOW` map is empty and should stay that way: a key that cannot be
shown to be read is a key an operator can set to no effect, and the honest fix
is to delete the declaration.

Removing a key is separately governed by the additive-only compatibility rule
in `pnpm config-schemas:check`, which fails on any removal. A removal that is
genuinely safe — because the key never had an effect to lose — takes a recorded
entry in that script's `REMOVAL_EXCEPTIONS`, with the reason.

To verify a violation is caught locally, add an unread key to any
`project-config.ts`, run `pnpm config-schemas`, then
`pnpm lint:project-config-keys`.

## Image builds

[`images.yml`](../../.github/workflows/images.yml) builds production images.
Nothing in CI did until card `5OV81`, and the price of that absence is on the
record twice:

- A `.dockerignore` line pruned `definitions/`, which two runtime stages copy
  out of their builder. Both images were unbuildable for six days.
- pnpm v10 made a non-injected `pnpm deploy` an error, and `pnpm deploy` is the
  last instruction of every builder stage here. All seventeen images and the
  template were unbuildable for months.

Neither showed up as a red build. Each was found by a card that ran
`pnpm docker:build` while doing something else.

The static checks around Docker — `lint-docker-context`, `lint-docker-deploy` —
were each written after one of those incidents, and each asks a question about
the *text* of a Dockerfile. A Dockerfile can satisfy every one of them and
still not build. Only a build settles that.

### Why three per push and not eighteen

| Roster           | Trigger                        | Images | Wall clock |
| ---------------- | ------------------------------ | ------ | ---------- |
| `representative` | every PR and push to `main`    | 3      | **1 min 50 s** |
| `full`           | nightly, 04:00 UTC             | 18     | **12 min 35 s** |

Eighteen images cost under seven times three, not six times, because the
seventeen units present byte-identical instructions over one build context up
to and including `pnpm install --frozen-lockfile`. The first image pays for
that layer (~45 s) and the rest reuse it, landing at 16–20 s each. Three
destinations are the exception at 100–137 s — their `pnpm deploy --prod` pulls
vendor SDKs the shared layer does not contain. The template shares nothing: its
`ARG` lines fork the layer chain at the second instruction, so it installs the
workspace again.

Eighteen on every push buys little over three: both defects above lived in the
base image or the shared build context, which the representative set reaches on
the first push rather than the next night. The nightly roster is what covers
the fifteen the per-push set does not touch.

The per-push set is not a sample of the tree, it is a cover of the ways a unit
can depend on the shared context:

| Target                 | Why it is in the set                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `sync-identity`        | copies `definitions/projects` out of the builder into its runtime stage — one half of the `.dockerignore` fault |
| `journey-orchestrator` | depends on the `definitions/*` workspace packages with `workspace:*` — the other half, in the builder rather than the runtime stage |
| `base`                 | the canonical template the other seventeen are copied from, and the file a fix once missed |

The membership lives in `scripts/docker-build.mjs`, not in the workflow, so
that `--set representative` runs locally exactly what CI runs. A test holds the
set to the shape above: dropping the async unit would otherwise narrow the gate
silently and leave the green tick unchanged.

The three apps (`ingester-api`, `control-plane-api`, `polaris-cli`) build
nightly only. Widening the per-push set is a one-line edit to `REPRESENTATIVE`.

### The gate proves it can fail

A build gate is the check that most easily becomes decorative: `docker build`
against a healthy tree looks identical whether the step is wired up or has
quietly stopped running anything. So `images.yml` breaks a Dockerfile on every
push, requires the build to fail, and restores it — the same harness, and the
same rule, as `verify:gates`:

```bash
node scripts/verify-gates.mjs --with-docker
```

The injected fault is a `COPY` of a context path that does not exist, placed
ahead of `COPY . .`. Both halves of that are deliberate. No lint can object to
it — `.dockerignore` does not prune the path, there is nothing to prune — so
only the build itself can notice, which is the case for building images at all.
And a fault planted after `COPY . .` would make the build reinstall the whole
workspace before reaching it, turning a seconds-long proof into a minutes-long
one, because injecting into a Dockerfile changes the build context.

### Running it locally

```bash
pnpm docker:build --set representative   # what every push builds
pnpm docker:build                        # all eighteen, what the nightly builds
pnpm docker:build --list                 # every target; * marks the per-push set
pnpm docker:build sync-identity          # one image
```

`pnpm docker:build` needs no `pnpm install` first. Each image installs the
workspace inside its own builder stage from the lockfile in the build context,
which is also why `images.yml` has no Node dependency cache: a build gate whose
install layer is restored from a cache stops noticing the class of break that
made it necessary.

### How these figures were measured

Both rosters were built from a **cold build cache** — pruned immediately
before each — on an isolated `docker-container` buildx builder, so the numbers
are what a runner with no warm cache pays. Reproduce with:

```bash
docker buildx create --name measure --driver docker-container
docker buildx prune -af --builder measure
BUILDX_BUILDER=measure pnpm docker:build --set representative
```

Four things to know before trusting the numbers:

- **The reference machine is faster than a runner.** 10 cores, Docker Desktop
  on `linux/arm64`. GitHub's `ubuntu-latest` has fewer; expect longer, which is
  why both jobs carry timeouts far above the measurement rather than near it.
- **Registry download time is included and dominates the outliers.** A first
  attempt at this measurement recorded a 196 s install where a later run
  recorded 11 s, entirely from npm registry stalls. Treat the per-image spread
  as network noise, not as a property of the image.
- **No image export.** The `docker-container` driver leaves the result in the
  build cache unless asked to load it, so the figures cover building an image
  and not writing it to a local image store. CI asserts buildability and
  publishes nothing, which is the same shape.
- **The tree must not change during a run.** Every Dockerfile does `COPY . .`,
  so editing any file that `.dockerignore` does not prune invalidates the
  shared install layer mid-roster and inflates the total. The first attempt at
  this measurement was spoiled exactly that way.



## Running the same checks locally

```bash
pnpm install
pnpm verify
```

`pnpm verify` **is** the gate, and it is the same command a change group runs
before it lands. Its chain is every pnpm gate `ci.yml` runs on a bare
checkout, in the order CI runs them:

```bash
node scripts/sync-injected-workspace-copies.mjs --check   # a precondition, not a gate
pnpm build                 # produces dist/ for every package — typecheck and tests need this
pnpm typecheck
pnpm lint                  # Biome + ClickHouse imports + raw-NUL + dead exports + process.env + project-config keys
pnpm format:check
pnpm openapi:check         # the OpenAPI document still matches the code
pnpm config-schemas:check  # generated config schemas in sync, and additive-only
pnpm verify:gates          # the meta-gate: prove every check can fail
pnpm test                  # workspace Vitest + scripts/ Vitest
```

The first line is a precondition rather than a gate, and it is why `pnpm
verify` opens with a `node` invocation instead of a pnpm script.
[ADR-0008](../adr/0008-inject-workspace-packages-on-deploy.md)'s injection
makes part of the workspace graph a hard-linked copy taken at install time,
before anything is built; a tree where that copy is stale fails `pnpm build`
with `TS2307` naming a package the change never touched. Provisioning normally
prevents it — `.pm/worktree-setup` and a step in each CI job that installs and
then builds — but provisioning only ever reaches trees created after it
landed. Group `31QH`'s worktree predated the hook by four cards and failed its
land on exactly that phantom error. The check asserts the precondition in
milliseconds and names both the cause and the one-command repair, so the gate
reports the tree it was given rather than a defect in innocent code.

It stays outside the pnpm chain deliberately: `lint-gate-parity` below holds
the pnpm gates in `verify` equal to CI's, and a precondition is not one of
them. CI enforces the same condition more strongly, by running the repair
outright.

Keeping that list correct is not left to whoever edits it:
[`scripts/lint-gate-parity.mjs`](../../scripts/lint-gate-parity.mjs) runs
inside `pnpm lint` and fails when `pnpm verify` and the workflows stop
naming the same set. It exists because they once did. The T0 change group
verified with `build && typecheck && lint && test`, `ci.yml` also ran
`pnpm format:check`, nothing compared the two — so a group whose every card
was green landed thirty-four unformatted files and turned `main` red.

The Makefile target `make ci` wraps the linter, typecheck, and test
trio (see [`Makefile`](../../Makefile)) but does not run the build,
the format check, or the generated-artifact checks. It is a fast inner-loop
shortcut and not the gate; `pnpm verify` is.

For the migration smoke step, run the local compose stack first:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:status
```

## Integration-tier checks

The integration workflow stands up real services and runs whatever
end-to-end suite is defined in the workspace. As of this writing, the
suite is a placeholder owned by:

- `P4-002 ClickHouse Ingestion Integration`
- `P5-001 Vertical Slice Smoke Test`

### Opting into integration on a PR

Apply the `integration` label to a PR. The workflow's
`pull_request: types: [labeled, synchronize]` trigger will pick it up
on the next push. Remove the label to stop further runs.

### Running integration manually

From the GitHub Actions UI, pick `Integration` and **Run workflow**
against the branch you want to test. No label required.

### Running integration locally

The same services live in `docker-compose.yml`. Bring them up with the
Makefile target:

```bash
make up                          # docker compose up -d --wait
pnpm db:migrate                  # apply PostgreSQL migrations
# (real integration test commands land with P4-002 / P5-001)
make down                        # stop containers
make nuke                        # stop and wipe volumes
```

## Caching

`ci.yml` and `integration.yml` use `actions/setup-node`'s built-in
`cache: pnpm`, which keys on `pnpm-lock.yaml`. The cache restores the
pnpm content-addressable store; `pnpm install --frozen-lockfile` then
links into each workspace's `node_modules` from that store. The cache
is shared across workflow runs on the same branch family.

`images.yml` has no such step and installs nothing on the runner. Its
only inputs are the checkout and two `.mjs` scripts that import nothing;
each image installs the workspace inside its own builder stage, from the
lockfile in the build context. Nothing there is cached between runs,
which is deliberate — a build gate whose install layer is restored from
a cache is a gate that stops noticing the class of break that made it
necessary.

If a CI run mysteriously fails on a fresh install, suspect the cache
first: re-run the job with **Re-run all jobs with debug logging**
enabled, which clears the cache for that run.

## Node and pnpm versions

- Node major: **22** (current Active LTS, matches the `engines.node`
  field in [`package.json`](../../package.json)). Pinned via the
  `NODE_VERSION` env var at the top of each workflow file.
- pnpm: **not pinned anywhere but
  [`package.json`](../../package.json)'s `packageManager` field**, which
  is the copy corepack and every local `pnpm` invocation already read.

There is no `PNPM_VERSION`, and adding one back would reintroduce a
seven-day outage. `pnpm/action-setup` refuses to run when its `version`
input and `packageManager` disagree, and it refuses at the install step —
before any gate runs, so every job reports a failure that says nothing
about the code. That is what happened when `a61bf2f` bumped
`packageManager` and left the workflow's copy behind: 60 consecutive red
runs, during which typecheck, lint, format and the whole test suite went
unenforced while each commit claimed them.

The Dockerfiles learned the same lesson separately. None of the eighteen
pins a pnpm version either — `scripts/lint-docker-deploy.mjs` fails the
build if one starts to — because a pin in a Dockerfile is a third copy of
the number, and the template outlived the fix that removed the other
seventeen.
