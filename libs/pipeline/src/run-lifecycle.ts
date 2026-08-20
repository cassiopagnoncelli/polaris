/**
 * Processor run lifecycle — the boot-to-shutdown wrapper around
 * `ProcessorRunRepository`.
 *
 * `./runs.ts` owns the repository contract (register / update / complete /
 * fail / cancel). This module owns the policy every processor applies on top
 * of it, so five processors do not each invent their own:
 *
 *   1. **The run id is allocated locally, before the row exists.** Derived
 *      events carry `processor.run_id` from the first message onward, and
 *      that id is what the row is inserted with. Waiting for PostgreSQL to
 *      hand back an id would mean either blocking the data path on the
 *      control-plane database or stamping something that is not the run —
 *      which is exactly the `synthetic:<event_id>` placeholder this replaces.
 *
 *   2. **Registration never blocks startup.** A processor whose control-plane
 *      database is unreachable still consumes; per
 *      `docs/architecture/00-overview.md`, RabbitMQ is the backbone and
 *      PostgreSQL holds runtime/control state. Losing the run row degrades
 *      observability, not delivery. The failure is logged at `warn` with the
 *      run id so the gap is greppable.
 *
 *   3. **A run that failed to register retries once at termination.** If the
 *      database was down at boot and up at shutdown, the row still lands —
 *      inserted with the same locally-allocated id, then immediately moved to
 *      its terminal status. Short outages leave a complete record rather than
 *      a hole.
 *
 *   4. **Counters are flushed on a heartbeat, not per message.** The
 *      repository contract asks for exactly that cadence. Without it an open
 *      run reads zero for its whole life, which is indistinguishable from a
 *      stalled processor. The timer is `unref`'d, so it never keeps a process
 *      alive, and a missed flush costs freshness only — the terminal write
 *      reconciles the totals.
 *
 * What this module deliberately does NOT do:
 *
 *   - No live metrics surface. The row's counters are for triage next to a
 *     run; throughput, lag, and failure RATES are Prometheus/Grafana's, per
 *     `docs/architecture/08-observability-and-operations.md`.
 *   - No gating. A run row records what DID run. Whether a processor SHOULD
 *     run for a `(project, environment)` is `processor_activations`, read by
 *     `./activation-gate.ts` — nothing here consults it.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see db/postgres/migrations/20260512000008_create_processor_runs.sql
 */

import type { Database } from "@polaris/persistence-postgres";
import { POLARIS_ENVIRONMENTS } from "@polaris/runtime-environments";
import type { Logger } from "@polaris/observability-logger";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

import type { ProcessorIdentity } from "./identity.js";
import {
  METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL,
  METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL,
  METRIC_PROCESSOR_EVENTS_FAILED_TOTAL,
  type ProcessorMetrics,
} from "./metrics.js";
import {
  createKyselyProcessorRunRepository,
  type ProcessorRunCounters,
  type ProcessorRunRepository,
} from "./runs.js";

/** Longest `error_summary` written to the run row. Stacks belong in Loki. */
const ERROR_SUMMARY_MAX_LENGTH = 500;

/**
 * The control plane's environment domain, enforced by the
 * `processor_runs_environment_allowed` CHECK constraint.
 *
 * A processor's own `config.service.environment` is a DEPLOYMENT label and its
 * domain is wider — a bare-metal dev stack runs with `POLARIS_ENV=local`.
 * Passing that straight through fails the constraint, and because registration
 * is deliberately non-fatal the only symptom is a missing row.
 */
const CONTROL_PLANE_ENVIRONMENTS: readonly string[] = POLARIS_ENVIRONMENTS;

/**
 * Deployment labels that legitimately have no control-plane environment. The
 * run is recorded unscoped rather than rejected, and without a warning: this
 * is the documented state of a dev machine, not a misconfiguration.
 */
const UNSCOPED_ENVIRONMENT_LABELS: readonly string[] = ["local", "test"];

/**
 * Narrow a deployment label to the control plane's environment domain.
 *
 * Returns `undefined` (an unscoped run) for anything outside it. Unrecognised
 * labels warn, because those are usually a typo in deployment config that
 * would otherwise cost the run its scope silently.
 */
function resolveEnvironment(environment: string | undefined, logger: Logger): string | undefined {
  if (environment === undefined) return undefined;
  if (CONTROL_PLANE_ENVIRONMENTS.includes(environment)) return environment;
  if (!UNSCOPED_ENVIRONMENT_LABELS.includes(environment)) {
    logger.warn(
      {
        component: "processor.run-lifecycle",
        environment,
        allowed: CONTROL_PLANE_ENVIRONMENTS,
      },
      "deployment environment is not a control-plane environment; recording the run unscoped",
    );
  }
  return undefined;
}

export interface StartProcessorRunInput {
  /**
   * Repository the run is recorded through. Callers that have no
   * control-plane database configured pass `undefined` and get a handle whose
   * terminal calls are no-ops — the run id is still allocated and stamped.
   */
  readonly repository: ProcessorRunRepository | undefined;
  readonly identity: ProcessorIdentity;
  /** Project scope. Omitted by cross-project processors (analytics-projector). */
  readonly project_id?: string | undefined;
  /** Environment scope: development | staging | production. */
  readonly environment?: string | undefined;
  /** Pod / hostname for triage. Defaults to `os.hostname()` at the call site. */
  readonly host?: string | undefined;
  /** Logger used for the registration-failure warning. */
  readonly logger: Logger;
  /**
   * Metrics registry the runtime increments. Read once at termination for the
   * run row's final counters. Omit to write zeroes.
   */
  readonly metrics?: ProcessorMetrics | undefined;
  /** Test seam for the allocated run id. */
  readonly run_id?: string | undefined;
  /** Test seam for `started_at` / `finished_at`. */
  readonly now?: (() => Date) | undefined;
  /**
   * How often to flush counters onto the open row, in milliseconds. `0`
   * disables the heartbeat. Defaults to {@link DEFAULT_HEARTBEAT_MS}.
   *
   * The cadence is per the repository contract's own guidance — "once per
   * heartbeat, not per message" — and a run that never flushed would show
   * zeroes for its entire life, which reads as a stalled processor.
   */
  readonly heartbeatMs?: number | undefined;
  /**
   * Timer factory. Defaults to `setInterval`, `unref`'d so the heartbeat
   * never keeps a process alive on its own. Tests inject a manual ticker.
   */
  readonly scheduler?: ProcessorRunScheduler | undefined;
}

/**
 * Timer seam. Production is `setInterval`/`clearInterval`; tests drive the
 * callback by hand rather than waiting on real time.
 */
export interface ProcessorRunScheduler {
  schedule(callback: () => void, intervalMs: number): () => void;
}

/** Flush counters onto the open row every 15s by default. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

const defaultScheduler: ProcessorRunScheduler = {
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    // A processor should exit when its runtime is done, not linger because a
    // bookkeeping timer is still registered.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Handle returned by {@link startProcessorRun}.
 *
 * `complete` and `fail` are terminal and idempotent: the second call is a
 * no-op, so a processor that fails during shutdown does not throw
 * `InvalidRunTransitionError` on top of the original error.
 */
export interface ProcessorRunHandle {
  /** UUIDv7 stamped onto every derived event this run emits. */
  readonly run_id: string;
  /** `true` once the row exists in `processor_runs`. */
  readonly registered: boolean;
  /**
   * Flush current counters onto the open row. Called on the heartbeat; also
   * exposed so a caller can force a flush (a test, or a drain before a
   * planned stop). No-op once the run is terminal.
   */
  heartbeat(): Promise<void>;
  complete(): Promise<void>;
  fail(error: unknown): Promise<void>;
}

/**
 * Register a processor run and return the handle the boot layer threads into
 * its runtime and shutdown tasks.
 *
 * Never throws. A repository error is logged and reflected in
 * `handle.registered`.
 */
export async function startProcessorRun(
  input: StartProcessorRunInput,
): Promise<ProcessorRunHandle> {
  const now = input.now ?? (() => new Date());
  const runId = input.run_id ?? uuidv7();
  const startedAt = now();
  const environment = resolveEnvironment(input.environment, input.logger);

  const register = async (): Promise<boolean> => {
    if (input.repository === undefined) return false;
    try {
      await input.repository.registerRun({
        run_id: runId,
        processor_name: input.identity.name,
        processor_version: input.identity.version,
        started_at: startedAt,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
        ...(environment !== undefined ? { environment } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
      });
      return true;
    } catch (err) {
      input.logger.warn(
        {
          component: "processor.run-lifecycle",
          run_id: runId,
          processor_name: input.identity.name,
          processor_version: input.identity.version,
          err: summarize(err),
        },
        "processor run registration failed; continuing without a run row",
      );
      return false;
    }
  };

  let registered = await register();
  let terminated = false;

  /**
   * Push current counters onto the open row.
   *
   * Skipped entirely when the run is terminal or was never registered, so a
   * heartbeat can never resurrect a finished row or race `completeRun`.
   * Failures log once and are otherwise ignored: a missed heartbeat costs
   * freshness, and the terminal write reconciles the totals anyway.
   */
  const heartbeat = async (): Promise<void> => {
    if (terminated || !registered || input.repository === undefined) return;
    try {
      await input.repository.updateRun({ run_id: runId, ...readCounters(input.metrics) });
    } catch (err) {
      input.logger.warn(
        { component: "processor.run-lifecycle", run_id: runId, err: summarize(err) },
        "processor run heartbeat failed; counters stay stale until the next one",
      );
    }
  };

  const heartbeatMs = input.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const scheduler = input.scheduler ?? defaultScheduler;
  const stopHeartbeat =
    heartbeatMs > 0 && registered
      ? scheduler.schedule(() => {
          void heartbeat();
        }, heartbeatMs)
      : undefined;

  const terminate = async (outcome: { readonly error?: unknown }): Promise<void> => {
    if (terminated) return;
    terminated = true;
    stopHeartbeat?.();
    if (input.repository === undefined) return;

    // The database may have come back since boot. One retry so a short
    // control-plane outage does not cost the whole record.
    if (!registered) registered = await register();
    if (!registered) return;

    const counters = readCounters(input.metrics);
    try {
      if (outcome.error === undefined) {
        await input.repository.completeRun({
          run_id: runId,
          finished_at: now(),
          ...counters,
        });
      } else {
        await input.repository.failRun({
          run_id: runId,
          finished_at: now(),
          error_summary: summarizeForColumn(outcome.error),
          ...counters,
        });
      }
    } catch (err) {
      input.logger.warn(
        {
          component: "processor.run-lifecycle",
          run_id: runId,
          err: summarize(err),
        },
        "processor run could not be closed out; row stays in status=running",
      );
    }
  };

  return {
    run_id: runId,
    get registered(): boolean {
      return registered;
    },
    heartbeat,
    complete: () => terminate({}),
    fail: (error: unknown) => terminate({ error }),
  };
}

export interface OpenProcessorRunInput extends Omit<StartProcessorRunInput, "repository"> {
  /**
   * Whether to record a run at all. Defaults to `true`. Processor tests that
   * build an app without PostgreSQL pass `false` so bootstrap does not reach
   * for a database that is not there.
   */
  readonly enabled?: boolean | undefined;
  /** Explicit repository. Wins over `db`; tests inject the in-memory adapter. */
  readonly repository?: ProcessorRunRepository | undefined;
  /**
   * Connection the run row is written through when no `repository` is given.
   * Processors pass the pool they already hold for transport checkpoints, so
   * recording a run costs no extra connection.
   */
  readonly db?: Kysely<Database> | undefined;
}

/**
 * Boot-time entry point every processor's `app.ts` calls.
 *
 * Resolves where the run should be recorded, then hands off to
 * {@link startProcessorRun}. **Always returns a handle**, so a processor can
 * treat `run.run_id` as unconditionally available — which is what let the
 * `synthetic:<event_id>` fallbacks inside the runtimes go away. Every derived
 * event schema in v1 declares `run_id` as required, so "no id" was never an
 * option; the only question was whether the id meant anything.
 *
 * `handle.registered` is that question's answer: `true` when a row exists to
 * join against, `false` when recording is off (tests) or the control-plane
 * database was unreachable at boot.
 */
export async function openProcessorRun(input: OpenProcessorRunInput): Promise<ProcessorRunHandle> {
  const repository =
    input.enabled === false
      ? undefined
      : (input.repository ??
        (input.db !== undefined
          ? createKyselyProcessorRunRepository({ db: input.db })
          : undefined));
  return startProcessorRun({ ...input, repository });
}

/**
 * Sum the run's event counters across every label tuple.
 *
 * `ProcessorMetrics` keys counters per label set (topic, project, outcome…);
 * the run row wants one number per counter for the whole process, so the
 * series are summed rather than sampled.
 */
export function readCounters(metrics: ProcessorMetrics | undefined): ProcessorRunCounters {
  if (metrics === undefined) return {};
  const totals = new Map<string, number>();
  for (const sample of metrics.getSamples()) {
    totals.set(sample.name, (totals.get(sample.name) ?? 0) + sample.value);
  }
  return {
    events_consumed: totals.get(METRIC_PROCESSOR_EVENTS_CONSUMED_TOTAL) ?? 0,
    events_emitted: totals.get(METRIC_PROCESSOR_EVENTS_EMITTED_TOTAL) ?? 0,
    events_failed: totals.get(METRIC_PROCESSOR_EVENTS_FAILED_TOTAL) ?? 0,
  };
}

/** Structured `err` field for a log line. */
function summarize(err: unknown): { name?: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { message: err };
  return {};
}

/** Short single-line summary for the `error_summary` column. */
function summarizeForColumn(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : "unknown error";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const text = collapsed.length === 0 ? "unknown error" : collapsed;
  return text.length > ERROR_SUMMARY_MAX_LENGTH
    ? `${text.slice(0, ERROR_SUMMARY_MAX_LENGTH - 1)}…`
    : text;
}
