/**
 * Shared validation for the `polaris replay` command group.
 *
 * The central rule for P7-001:
 *
 *   Replay JOBS are runtime state — they belong in PostgreSQL. Replay
 *   PLANS (what gets replayed, the windowing rules, the partition
 *   strategy) are CODE — they live in the planner package shipped by
 *   P7-002. The CLI MUST refuse to write planner semantics through the
 *   job-record surface.
 *
 * This module enforces that contract before any value reaches the DB
 * repository. The rejection list of disallowed flag/argument names lives
 * here so every mutating command in the group enforces the same gate.
 *
 * Mirrors the defense-in-depth pattern P6-004 / P6-005 established:
 *
 *   1. The migration's column set has no planner-semantic columns.
 *   2. The `InsertReplayJobInput` interface has no planner-semantic
 *      fields, so even a programmatic caller cannot smuggle one in.
 *   3. The argument validator below rejects rule-shaped flags BEFORE any
 *      DB write happens.
 *   4. The schema-invariant test in `replay-commands.test.ts` asserts the
 *      column set on disk matches the typed surface.
 *
 * @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
 * @see docs/implementation/tasks/P7-001-replay-job-model-cli.md
 */
import { UsageError } from "../../errors.js";

/**
 * Flag and argument tokens that look like an attempt to declare replay
 * PLAN semantics. If the CLI ever receives one of these, every mutating
 * replay command rejects with a usage error BEFORE any DB write.
 *
 * The list intentionally covers:
 *
 *   - planner-internal partitioning + chunking knobs (live in P7-002 code)
 *   - transform / mapping overrides (would change emitted event meaning)
 *   - I/O topic overrides (replay reads from raw.events; routing is owned
 *     by the planner)
 *   - inline runtime config blobs
 *   - schema overrides
 *
 * The match is case-insensitive and matches both the flag form
 * (`--partition-strategy`) and the underlying option name commander
 * stores (`partitionStrategy`).
 */
export const FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS: readonly string[] = [
  // Partitioning + chunking — planner-internal (P7-002)
  "partition-strategy",
  "partition_strategy",
  "partitionstrategy",
  "partitioning",
  "partitioner",
  "chunk",
  "chunks",
  "chunking",
  "chunking-rules",
  "chunking_rules",
  "chunkingrules",
  "chunk-size",
  "chunk_size",
  "chunksize",
  "batch-strategy",
  "batch_strategy",
  "batchstrategy",
  // Transform / mapping overrides — would change emitted event meaning
  "transform",
  "transforms",
  "transform-override",
  "transform_override",
  "transformoverride",
  "rule",
  "rules",
  "ruleset",
  "mapping",
  "mappings",
  "field-map",
  "field_map",
  "fieldmap",
  "event-map",
  "event_map",
  "eventmap",
  "enrichment",
  "enrich",
  // I/O topic overrides — replay sources are owned by the planner
  "input-topic",
  "input_topic",
  "inputtopic",
  "output-topic",
  "output_topic",
  "outputtopic",
  "topic",
  "topics",
  "source-topic",
  "source_topic",
  "sourcetopic",
  // Inline runtime config blobs
  "config-blob",
  "config_blob",
  "configblob",
  "config-json",
  "config_json",
  "configjson",
  "runtime-config",
  "runtime_config",
  "runtimeconfig",
  // Schema overrides — schema_version is declared by the catalog
  "schema",
  "schemas",
  "schema-version-override",
  "schema_version_override",
  "schemaversionoverride",
];

/**
 * Normalise a flag/option name into the same shape as
 * {@link FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS}. commander stores option
 * names in camelCase (`--partition-strategy` -> `partitionStrategy`), so
 * we lowercase and convert camelCase boundaries to hyphens before
 * comparing.
 */
function normaliseFlagName(name: string): string {
  return name
    .replace(/^--?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Reject any flag/argument token that looks like an attempt to define
 * replay PLAN semantics. Used by every mutating replay command (create,
 * cancel, pause, resume) so a future caller cannot smuggle a planner
 * field through any surface.
 *
 * Throws {@link UsageError} so the dispatcher returns exit code 2 and the
 * caller can detect the rejection in scripts.
 */
export function rejectReplayPlanArguments(args: Readonly<Record<string, unknown>>): void {
  for (const rawKey of Object.keys(args)) {
    const value = args[rawKey];
    if (value === undefined) continue;
    const normalised = normaliseFlagName(rawKey);
    if (FORBIDDEN_REPLAY_PLAN_FLAG_TOKENS.includes(normalised)) {
      throw new UsageError(
        `--${normalised} is not accepted by the replay CLI. ` +
          "Replay PLAN semantics (partitioning, chunking, transform overrides, " +
          "topic routing) live in versioned code under the replay planner " +
          "package (P7-002) and are NEVER stored in PostgreSQL. The replay-job " +
          "row records the operator's intent (project, environment, target, " +
          "mode, time window, reason) and nothing more. To change planner " +
          "behavior, ship a new planner version.",
      );
    }
  }
}

/**
 * Operational retention window in days. Polaris does not promise replay
 * beyond the operational retention of the source topic (Redpanda
 * `raw.events` ships with 90 days by default per
 * docs/architecture/05-processors-and-replay.md "Replay Window"). The
 * value is hard-coded here so the CLI's reject-message tells the operator
 * exactly what the window was when the rejection happened.
 */
export const REPLAY_WINDOW_DAYS = 90;
export const REPLAY_WINDOW_MS = REPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Reject a `--from` timestamp older than the operational retention
 * window. The error code is `replay_window_exceeded` in the message body
 * so scripts can grep for it.
 *
 * The `now` parameter is taken from the runner's clock hook so tests
 * pinning `Date.now` deterministically can validate the boundary.
 */
export function assertWithinReplayWindow(windowFrom: Date, now: Date): void {
  const earliestAllowed = new Date(now.getTime() - REPLAY_WINDOW_MS);
  if (windowFrom.getTime() < earliestAllowed.getTime()) {
    throw new UsageError(
      `replay_window_exceeded: --from ${windowFrom.toISOString()} is older than the ` +
        `${REPLAY_WINDOW_DAYS}-day operational retention window ` +
        `(earliest replayable: ${earliestAllowed.toISOString()}). ` +
        "Polaris does not promise replay beyond the operational retention window. " +
        "Archive-restore is future work and would extend the same control plane.",
    );
  }
}

/**
 * Parse an ISO 8601 timestamp string into a `Date`. Used by the create
 * runner for `--from` and `--to`. Throws {@link UsageError} when the
 * value is not a parseable ISO timestamp.
 */
export function parseIsoTimestamp(value: string, flag: string): Date {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new UsageError(`${flag} is required`);
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(
      `${flag} must be an ISO 8601 timestamp (e.g. 2026-05-01T00:00:00Z), got "${value}"`,
    );
  }
  return parsed;
}
