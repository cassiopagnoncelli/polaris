# Processor Manifests, Changelogs, and Golden Fixtures

This doc is the contract that every released processor version in
`processors/<name>/v<n>/` follows. It pairs with the architectural rules
in [Processors and Replay](../architecture/05-processors-and-replay.md)
and [Engineering Standards](../architecture/09-engineering-standards.md);
where those docs state the policy, this one names the file layout and the
schema.

If you are about to add a new processor or bump an existing one to a new
major version, read this end-to-end. If you are touching a released v1
processor, the **Semantic Immutability Rule** below tells you whether
your change is allowed.

## Why this exists

Polaris processors are independent, versioned services. The runtime, the
replay control plane, and the CLI (`polaris processors list / show /
enable / disable`) all need a single trustworthy place to read each
processor's identity: name, version, owner, input/output topic families,
state stores, replay support, and lifecycle status.

That place is the per-version `processor.manifest.yaml`. Every released
processor version owns one. The manifest is checked-in code — it lives
next to the processor's `src/` and ships with the build.

## Per-version layout

Every released processor version follows the same on-disk layout:

```text
processors/
  <name>/
    v<n>/
      processor.manifest.yaml   # SEMANTIC definition for (name, vN)
      CHANGELOG.md              # version-scoped change log
      package.json              # workspace package metadata
      src/                      # implementation
      test/
        golden/                 # P8-006 golden input/output fixture pairs
          <scenario>.input.json
          <scenario>.output.json
        <unit-and-integration-tests>.test.ts
        manifest.test.ts        # cross-cutting manifest validation test
      tsconfig.json
      vitest.config.ts
      Dockerfile
```

The five v1 processors released against this contract are:

```text
processors/analytics-projector/v1/
processors/identity-resolver/v1/
processors/sessionizer/v1/
processors/geoip-enricher/v1/
processors/attribution-engine/v1/
```

## Manifest schema

The Zod source of truth is
[`packages/shared-processor/src/manifest.ts`](../../packages/shared-processor/src/manifest.ts).
The schema rejects unknown top-level keys (`.strict()`) so typos fail
loud at boot. The CLI carries a near-duplicate at
`apps/polaris-cli/src/catalog/processors.ts`; a follow-up cross-cut will
consolidate the two by importing this package's schema into the CLI.
Until that lands, the CLI's strict parser warns on the
`release_status` / `replay_notes` / `fixtures` keys P8-006 adds, but the
runtime helpers (which use this package) accept them.

### Top-level fields

| Field            | Type                                | Required        | Notes                                                                                                                                                |
| ---------------- | ----------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | string, lowercase + `[_-]`, 3-64    | yes             | Matches the directory under `processors/`.                                                                                                           |
| `version`        | `v<int>` or `v<int>.<int>(.<int>)?` | yes             | Matches the directory under `processors/<name>/`.                                                                                                    |
| `owner`          | string, 1-128                       | yes             | Team handle: `platform-data`, `platform-identity`, ...                                                                                               |
| `description`    | string, 1-8192                      | yes             | Multi-paragraph prose. Owns the "what this processor does" explanation.                                                                              |
| `release_status` | `released` / `deprecated` / `experimental` | **new in P8-006** | Lifecycle flag. Production-active processors are `released`. See "Release lifecycle".                                                                |
| `mode`           | `streaming` / `batch`               | yes             | Closed set. `streaming` maps inputs 1:1, 1:n, or 1:0 to outputs; `batch` aggregates. Mode is semantic.                                                |
| `inputs`         | array of `{family, schema_versions}` | yes (≥1)        | Topic families and accepted schema versions. The shared-kafka topic-family resolver turns these into concrete topic names per project isolation state. |
| `outputs`        | array of `{family, schema_versions}` | yes (≥1)        | Same shape as `inputs`. Output topic families are the contract downstream consumers join against.                                                    |
| `state_stores`   | array of strings                    | yes (default `[]`) | Strings of the form `<backend>:<resource>` (e.g. `postgres:identity_links`, `memory:sessions`, `memory:touchpoints`). Empty for stateless processors. |
| `defaults`       | object (passthrough)                | optional        | Operational knobs the runtime falls back to when no activation row overrides them. Mostly non-semantic; see "Semantic-vs-operational defaults".      |
| `replay`         | `{supported, restrictions}`         | optional        | Machine-readable replay flag and named restriction strings. Restrictions are consumed by tooling.                                                    |
| `replay_notes`   | string, 1-8192                      | **new in P8-006** | Free-form prose explaining replay behavior for operators. The machine surface is `replay.restrictions`; this field is for the runbook.               |
| `fixtures`       | array of `{name, input, output, description?}` | **new in P8-006** | Golden input/output fixture pairs. Paths are relative to the manifest file. The validator helper asserts files exist and parse as JSON.              |

### Release lifecycle

`release_status` is a closed set:

- **`released`** — production semantics for this `(name, version)` pair.
  The directory is immutable in semantic behavior (see "Semantic
  Immutability Rule"). All five v1 processors released against this
  contract are `released`.
- **`deprecated`** — superseded by a newer version. Still consumable for
  replay; no new processor runs should target it. A future v2 of any
  processor would flip its predecessor's `release_status` from
  `released` to `deprecated` as a non-semantic CHANGELOG entry.
- **`experimental`** — opt-in, not yet promoted. Tests, smoke harnesses,
  and individual operator opt-ins may use it; production activations
  should not. Useful for landing a v2 directory before flipping live
  traffic.

### Fixtures block

The `fixtures` block declares golden input/output pairs the test suite
asserts against. Each entry pins one canonical scenario:

```yaml
fixtures:
  - name: payment-approved
    input: test/golden/payment-approved.input.json
    output: test/golden/payment-approved.output.json
    description: |
      Canonical payment.approved event from a backend SDK. Exercises the
      full envelope passthrough + the dual-shape processor stamp.
```

Paths are relative to the manifest file. The fixture-validation helper
in `@polaris/shared-processor` resolves them and asserts both files
exist and parse as JSON; per-processor `manifest.test.ts` files run that
helper. The processor's regular `transform.test.ts` / `emit.test.ts`
files import the same fixtures and assert the transform produces the
expected output byte-for-byte (deterministic clock pinned in the test).

### Replay metadata

The `replay` block is the machine-readable surface:

```yaml
replay:
  supported: true
  restrictions:
    - first_touch_replay_caveat
    - last_touch_replay_caveat
```

The `replay_notes` block is the prose for the runbook:

```yaml
replay_notes: |
  Replays of analytics.events produce identical touchpoint_captured
  events byte-for-byte because the touchpoint_id derivation is a pure
  function of (source_event_id, canonical_campaign_tuple). The
  first_touch_assigned and last_touch_assigned events carry replay
  caveats: the in-memory chain is rebuilt FROM THE BEGINNING of the
  replay slice ... [continues]
```

Restrictions are named tokens (snake_case) so tooling can branch on
them; the prose explains why each restriction exists.

## Semantic Immutability Rule

This is the load-bearing architectural rule the manifest contract
enforces.

**A released processor version's manifest may NEVER change in a way that
alters the processor's semantic identity for that version.**

Concretely, the following fields are SEMANTIC for a `(name, version)`
pair:

- `name`, `version`
- `mode`
- `inputs.family` and `inputs.schema_versions`
- `outputs.family` and `outputs.schema_versions`
- any `defaults` value the architecture doc marks as semantic
  (see "Semantic-vs-operational defaults" below)
- the processor's emitted-event shape (defined by the processor's
  source code, but reflected through `outputs.schema_versions`)

If a change would alter any of those, the change requires a NEW
processor version directory (e.g. `v2/`) with its own manifest. The
escape valve is always "create the next version directory", never "edit
the released directory's manifest".

The following changes are allowed inside a released directory:

- security fix
- dependency patch
- observability improvement
- non-semantic bug fix with explicit CHANGELOG
- flipping `release_status` from `released` to `deprecated` when a new
  version supersedes it
- editing `description` / `replay_notes` to clarify existing behavior
- adding new fixture pairs (existing pairs are immutable byte-for-byte)

The CHANGELOG documents every change, semantic or not. Semantic changes
land as a new version with its own CHANGELOG entry; non-semantic changes
land as additional entries inside the existing version's CHANGELOG.

### Semantic-vs-operational defaults

The `defaults` block is mostly non-semantic — the runtime may override
`consumer_group`, `partitions_consumed_concurrently`, batch sizes, etc.
without bumping the processor version. But some defaults ARE semantic.
The clearest example is sessionizer v1's `session_inactivity_seconds`:
changing the inactivity window changes which events get
`session.started` vs `session.ended`, which IS a change to emitted
event meaning. Per the architecture rule "if changing a setting can
change emitted event meaning, fields, identity links, attribution
outcomes, filtering behavior, or output schema, the setting is
semantic", a bump of `session_inactivity_seconds` requires a new
processor version.

The convention: when a `defaults` value is semantic, the manifest's
comment block calls it out explicitly, AND the per-processor
`manifest.test.ts` asserts the exact value so accidental drift fails
fast in CI.

## CHANGELOG convention

Every released version has a `CHANGELOG.md` next to its `processor.manifest.yaml`.
The file is owned by the version and frozen with the version.

Shape:

```markdown
# <processor-name> v1 changelog

Processor versions are immutable in semantic behavior. This changelog
records non-semantic fixes ... [boilerplate explaining the immutability
rule].

## v1 — manifest standardisation (P8-006, YYYY-MM-DD)

Non-semantic. [What changed.]

## v1.0.0 — initial release (PX-XYZ)

- Bullet list of the initial behavior, references, and known limitations.
```

Rules:

- The newest entry is at the TOP of the file (latest first).
- Each entry carries either an explicit `vMAJOR.MINOR.PATCH` tag or
  the version label plus a parenthetical task-card reference and date.
- Non-semantic entries say so in the first sentence. Semantic changes
  land in a NEW version's CHANGELOG, not this file.
- Do NOT rewrite earlier entries. Even fixing a typo in the
  initial-release entry is preserved-as-history (add a new entry that
  notes the clarification rather than editing the original).

## Golden fixtures convention

Per the engineering standards, "golden fixtures for canonical event
input/output examples" is a required test style. The P8-006 convention:

- Each fixture lives under `test/golden/<scenario>.input.json` and
  `test/golden/<scenario>.output.json`. The two files are paired; tests
  load both and assert `transform(input) === output` byte-for-byte
  (after pinning the runtime clock).
- Fixtures are **hand-curated and deterministic**. They are NOT
  exhaustive coverage; they are CANONICAL examples that pin the
  processor's input → output contract. Coverage lives in the
  processor's regular unit tests.
- The expected-output side of the pair is the processor's CONTRACT for
  that scenario. Editing an output fixture for a released version is
  a SEMANTIC change and is forbidden by the Semantic Immutability Rule;
  any output diff means "create v2", not "patch v1".
- Fixtures are JSON, not YAML. The on-disk wire format is JSON for
  Kafka payloads and ClickHouse rows; keeping fixtures in JSON makes
  them paste-and-diff against the actual streamed bytes.
- Determinism is enforced by:
  - pinned event IDs (UUIDv7-shaped strings),
  - pinned timestamps,
  - pinned hash-derived IDs (`sess_<hex>`, `tp_<hex>`,
    `source_ip_hash`),
  - tests injecting a deterministic `now()` clock so the processor
    stamp's `ran_at` is pinned to a known instant.

The `geoip-enricher`'s pre-existing `test/fixtures/geoip-sample.json` is
NOT a golden input/output pair — it's the `InMemoryIPLookup`'s database.
It stays where it is. The golden pair lives separately under
`test/golden/`.

## Validation tests

There are TWO test layers for manifests:

1. **Shared schema test** —
   `packages/shared-processor/test/manifest.test.ts` asserts the Zod
   schema accepts every documented field and rejects invalid shapes
   (mode outside the closed set, `release_status` outside the closed
   set, fixture entries with extra keys, etc.). It uses a temp-dir
   fixture; it does NOT read the real on-disk manifests.

2. **Per-processor manifest test** —
   `processors/<name>/v1/test/manifest.test.ts` loads the REAL on-disk
   manifest via `@polaris/shared-processor`'s `loadProcessorManifest`,
   asserts the values specific to that processor (expected topic
   families, owner, state stores, semantic defaults, ...), and runs
   `validateProcessorFixtures` to confirm every fixture path the
   manifest references actually exists on disk and parses as JSON.

   This file is the first thing CI runs when a processor manifest is
   touched. If it fails, the manifest is invalid and the PR cannot
   merge.

Both layers run as part of `pnpm test`. The per-processor test catches
"someone renamed the output topic family by accident"; the shared test
catches "someone added a key the schema doesn't know about".

## Adding a new released processor

1. Create `processors/<name>/v1/` with the layout above.
2. Write `processor.manifest.yaml` with `release_status: released`,
   the `inputs`/`outputs` topic families, the state stores, and a
   `replay` block.
3. Add at least one `fixtures:` entry referencing a golden pair under
   `test/golden/`.
4. Write `test/manifest.test.ts` modeled after the v1 processors in
   this repo. It MUST call `loadProcessorManifest` and
   `validateProcessorFixtures` against the on-disk file.
5. Write `CHANGELOG.md` with a `## v1.0.0 — initial release` entry.
6. Run the full workspace gate (`pnpm -r build`, `pnpm typecheck`,
   `pnpm lint`, `pnpm format:check`, `pnpm test`). All must pass.

## Bumping a processor to a new version

1. Create `processors/<name>/v2/` as a SIBLING of `v1/`. Do NOT modify
   `v1/`.
2. The new directory carries its own manifest, CHANGELOG, fixtures,
   and tests.
3. Optionally flip `v1/processor.manifest.yaml`'s `release_status` from
   `released` to `deprecated` in a non-semantic CHANGELOG entry. This
   is the ONLY field the release directory's manifest is allowed to
   change after launch.
4. The replay control plane targets exact `(name, version)` pairs; v1
   stays operable for replays of older raw events while v2 takes new
   traffic.

## References

- [Processors and Replay](../architecture/05-processors-and-replay.md) —
  the architectural contract this doc operationalises.
- [Engineering Standards](../architecture/09-engineering-standards.md)
  § "Testing" — golden-fixture testing as a required test style.
- [`packages/shared-processor/src/manifest.ts`](../../packages/shared-processor/src/manifest.ts) —
  the Zod schema source of truth.
- [`packages/shared-processor/test/manifest.test.ts`](../../packages/shared-processor/test/manifest.test.ts) —
  the schema-validation tests.
