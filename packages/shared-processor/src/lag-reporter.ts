/**
 * Per-partition consumer lag, reported from a TIMER.
 *
 * `ProcessorMetrics.observeLagMs` has existed since P10-002 and has never been
 * called. Two Prometheus alert rules reference the metric it writes and two
 * Grafana panels plot it, so both alerts have been unable to fire and both
 * panels have plotted an empty series, while `docs/operations/alerts.md`
 * claimed every rule referenced a real metric.
 *
 * ## Why a timer and not the message path
 *
 * This is the part that decides whether the metric is worth having. A gauge
 * updated inside the handler can only move when a message arrives, so it
 * freezes at its last value the moment the flow stops — and a stalled reader,
 * a partition nobody consumes, or a processor disabled for a project all look
 * identical to a healthy idle one. The ABSENCE of messages is exactly the
 * condition worth alerting on, and a message-path gauge is structurally
 * incapable of expressing it.
 *
 * So the handler only records WHEN the last message for a partition was
 * ingested. A timer publishes `now - that`, which keeps climbing while nothing
 * arrives. A partition that has never delivered anything reports nothing at
 * all rather than zero, because zero would read as "perfectly current".
 *
 * @see docs/operations/runbook-processor-lag.md
 */

import type { ProcessorIdentity } from "./identity.js";
import type { ProcessorMetrics } from "./metrics.js";

/**
 * How often lag is published. Well inside the 5m alert window.
 *
 * Module-private: an app that wanted to tune this would be tuning a metric
 * cadence, which is not a knob this repository has earned the right to add.
 */
const DEFAULT_LAG_REPORT_INTERVAL_MS = 10_000;

/** Timer seam. Production is `setInterval`; tests drive the tick by hand. */
export interface LagScheduler {
  schedule(callback: () => void, intervalMs: number): () => void;
}

const defaultScheduler: LagScheduler = {
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    // A metrics timer must never be the reason a process stays alive.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * Separates the fields of a tracking key.
 *
 * NUL, and BUILT rather than written: a literal NUL byte in source makes the
 * file binary to ripgrep (which is what `pnpm lint:nul-bytes` catches), and a
 * `\u0000` escape is something formatters and editors keep helpfully
 * converting into that byte. `String.fromCharCode(0)` survives both, and is
 * the form this repo's own NUL-byte test already uses.
 *
 * A space would be cheaper and wrong: a project id containing a space would
 * merge two partitions' readings into one series.
 */
const KEY_SEPARATOR = String.fromCharCode(0);

export interface ObserveLagInput {
  readonly family: string;
  readonly partition: number;
  readonly project_id: string;
  readonly environment: string;
  /** `ingested_at` of the message, ISO 8601. */
  readonly ingestedAt: string;
}

export interface LagReporter {
  /** Record that a message for this partition was handled. */
  observe(input: ObserveLagInput): void;
  /** Publish lag for every tracked partition. Called on the timer. */
  report(): void;
  /** Stop the timer. Idempotent. */
  stop(): void;
}

export interface CreateLagReporterInput {
  readonly metrics: ProcessorMetrics;
  readonly identity: ProcessorIdentity;
  readonly intervalMs?: number | undefined;
  readonly scheduler?: LagScheduler | undefined;
  readonly now?: (() => number) | undefined;
}

export function createLagReporter(input: CreateLagReporterInput): LagReporter {
  const now = input.now ?? (() => Date.now());
  const intervalMs = input.intervalMs ?? DEFAULT_LAG_REPORT_INTERVAL_MS;
  const tracked = new Map<string, { ingestedAtMs: number; input: ObserveLagInput }>();

  function report(): void {
    const at = now();
    for (const entry of tracked.values()) {
      input.metrics.observeLagMs(
        {
          processor_name: input.identity.name,
          processor_version: input.identity.version,
          project_id: entry.input.project_id,
          environment: entry.input.environment,
          topic_family: entry.input.family,
          partition: entry.input.partition,
        },
        Math.max(0, at - entry.ingestedAtMs),
      );
    }
  }

  const stopTimer =
    intervalMs > 0 ? (input.scheduler ?? defaultScheduler).schedule(report, intervalMs) : undefined;
  let stopped = false;

  return {
    observe(observed: ObserveLagInput): void {
      const ingestedAtMs = Date.parse(observed.ingestedAt);
      // An unparseable timestamp is a producer bug, not a lag reading. Silently
      // tracking NaN would publish NaN and poison the panel.
      if (Number.isNaN(ingestedAtMs)) return;
      const key = [
        observed.family,
        String(observed.partition),
        observed.project_id,
        observed.environment,
      ].join(KEY_SEPARATOR);
      tracked.set(key, { ingestedAtMs, input: observed });
    },
    report,
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTimer?.();
    },
  };
}
