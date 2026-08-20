# Acceptance Test (Engineering Reference)

This is the engineering companion to the operator runbook in
[`docs/release/acceptance-test-runbook.md`](../release/acceptance-test-runbook.md).

If you are an operator running the release gate, read the runbook
first. If you are a contributor about to add or modify a scenario
step, you are in the right place.

## Scope summary

The acceptance test is a single Vitest scenario at
`tests/acceptance/scenarios/full-pipeline.test.ts` plus a runner
script at `scripts/run-acceptance.mjs`. Together they prove the
canonical Polaris event path end-to-end through production-shipped
surfaces only.

| Asserts | Does NOT assert |
| --- | --- |
| Control-plane catalog can be synced | Vendor destinations against a live API (Meta CAPI, GA4, TikTok, Braze) — out of scope; webhook-sink is the proxy. |
| Backend API keys can be issued via the CLI | Dashboards actually render — only that the observability docs exist. |
| Webhook-sink destinations can be created + enabled | Replay live execution — `dry_run` only. |
| The Node SDK delivers a `checkout.started` v1 event | Chaos / failover / partial outages — not a chaos test. |
| The ingester returns per-event `accepted` | Load characteristics — sends exactly one event. |
| the spine writes the row into `analytics_raw` | Web SDK — Node SDK is canonical for deterministic test runs. |
| A delivery_records row appears for the event | |
| `polaris replay create` + `polaris replay plan` work | |
| The acceptance + ops runbooks exist and are non-empty | |

The boundaries are deliberate. Pushing them further turns the gate
into an integration suite.

## Gating

The scenario is **gated** the same way `tests/smoke/vertical-slice.test.ts`
is gated.

```ts
const SHOULD_RUN = process.env["POLARIS_ACCEPTANCE_TEST"] === "1";

describe.skipIf(!SHOULD_RUN)("product acceptance (full pipeline)", () => {
  // ...
});
```

This keeps the default `pnpm test` (executed on every PR) cheap and
Docker-free. The acceptance test only runs when:

- `scripts/run-acceptance.mjs` flips the env var on (the supported
  path, invoked as `pnpm test:acceptance`), or
- an operator manually exports `POLARIS_ACCEPTANCE_TEST=1` before
  running Vitest against `tests/acceptance/scenarios/`.

Confirm the gate is working with:

```bash
# default — should skip the scenario silently
pnpm test

# gate flipped — runs the scenario
pnpm test:acceptance
```

`pnpm test` also includes `tests/smoke/`, which has the matching
gate `POLARIS_SMOKE_DOCKER=1`. The two gates are independent: a fresh
PR run skips both, the integration CI run flips the smoke gate,
and the release gate flips the acceptance gate.

## Architecture

```text
scripts/run-acceptance.mjs          (operator entry point)
  -> pnpm exec vitest run tests/acceptance/scenarios/full-pipeline.test.ts
       -> beforeAll: runAcceptanceScenario()
            -> tests/acceptance/lib/scenario.mjs
                 -> [shells out to `polaris` CLI binary]
                 -> [imports @polaris/node-sdk]
                 -> [HTTP fetch against ClickHouse]
                 -> [reads docs/* for the documentation step]
       -> N + 2 `it()` assertions (one per step + ordering + verdict)
```

The split between `scenario.mjs` and the Vitest wrapper is the same
pattern the vertical-slice smoke uses:

- The **library** (`scenario.mjs`) is plain ESM with no Vitest
  dependency. It can be imported by the runner script for the
  pre-flight banner without forcing Vitest to load.
- The **wrapper** (`full-pipeline.test.ts`) translates the result
  object into one `it()` per step so the Vitest reporter shows each
  pipeline stage as its own pass/fail row.

The companion `tests/acceptance/lib/scenario.d.mts` declares the
runtime's TypeScript surface for the wrapper.

## Production-surface rule

This is the hard rule that distinguishes the acceptance test from a
unit test:

> Every step uses ONLY production-shipped surfaces. The CLI is invoked
> as the compiled binary, the SDK is imported by package name, HTTP
> calls hit the real ingester, ClickHouse queries go through the
> documented HTTP endpoint. No internal helpers, no fakes, no mocks.

If you find yourself reaching into a `packages/*/src/` file directly,
or constructing an envelope by hand instead of via the SDK, that step
no longer counts as acceptance — it's a unit test in a release-gate
costume.

The one allowed compromise is documentation assertions (step 9).
Those read files via `node:fs` because that *is* the production
surface for documentation.

## Adding a new step

The scenario steps live as an ordered array of `runStep` calls inside
`runAcceptanceScenario` in `tests/acceptance/lib/scenario.mjs`. To
add a step:

1. Choose a stable `id` — snake_case, one verb-noun phrase, unique
   across the scenario. The id is the grep handle operators use to
   find the failure in logs.
2. Write the step body as an async function that returns a
   "detail" value (any JSON-serialisable structure) on success,
   throws an `AcceptanceStepError` on failure, or returns
   `{ skip: true, reason: string }` to declare an explicit skip.
3. Mutate the shared `state` object only when downstream steps need
   to consume your output. Read-only steps should not touch `state`.
4. Append the new id to `EXPECTED_STEPS` in
   `tests/acceptance/scenarios/full-pipeline.test.ts`. The ordering
   assertion forces the wrapper and the library to march in lockstep.
5. Add a row to the step table in
   [`docs/release/acceptance-test-runbook.md`](../release/acceptance-test-runbook.md)
   so operators see the new step in the runbook.
6. Add a failure mode entry to the same runbook describing what a
   failure of your step usually means.

A step **should** be skippable when its preconditions are not met. A
step **should not** crash the entire scenario when an upstream step
failed — return a `{ skip: true, reason: "..." }` instead. The
wrapper still reports it as a pass-equivalent row, but the verdict
upstream is FAIL because the upstream step is FAIL.

## Coverage matrix

The acceptance test does NOT reprove what other tests already cover.
Concretely:

| Concern | Owner |
| --- | --- |
| Ingester request validation, per-event reject codes | `apps/ingester-api/test/**` (unit + behavioural). |
| Node SDK retry policy, queue overflow, drop reasons | `packages/node-sdk/test/**` (unit). |
| spine emit shape | `sync/identity/resolver/v1/test/**`, `sync/enrichment/runtime/v1/test/**`. |
| Replay planner deterministic output | `libs/archive/replay/test/**`. |
| CLI argument parsing per command | `apps/polaris-cli/test/**`. |
| Single-event ingester-to-ClickHouse path | `tests/smoke/vertical-slice.test.ts`. |
| Destination-runtime behavioural tests | `sync/destinations/webhook-sink/v1/test/**`, `libs/delivery/destinations/test/**`. |

The acceptance test asserts these capabilities **are wired together**.
A unit-level fix is the right response when a step fails because of a
local regression in one of the owners above.

## Cleanup posture

The scenario does **not** auto-clean its writes:

- API keys minted by step 2 stay in `api_keys`. The audit row stays in
  `audit_records`. This is deliberate — a forensic trail of every
  acceptance run is valuable when triaging an inconsistent gate.
- Replay jobs created by step 8 stay in `replay_jobs` with
  `status='pending'`. They are dry-run only and never advance.
- The destination created by step 3 is idempotent on re-runs (unique
  on `project / env / vendor / instance_label`), so successive runs
  reuse it.

Operators who want a clean slate can drop test rows manually; the
acceptance runbook documents the prefix patterns to grep for.

## Failure escalation

If the gate fails:

1. Read the per-step error message in the Vitest reporter; the step
   `id` plus the error tells you exactly which production surface
   regressed.
2. Cross-reference the runbook's failure-mode table for the suspected
   cause.
3. If the failure is reproducible on a clean stack (fresh `docker
   compose down && up`), it is a release blocker. File an issue with
   the step id in the title.
4. If the failure is transient (network blip, ClickHouse warm-up),
   re-run once. The scenario polls with a 60s timeout per step; a
   second run that also fails is a real signal.

The acceptance test is not where you go to debug *why* something
broke. It is where you go to find out *which surface* broke. The
runbooks linked from each step are the next stop.
