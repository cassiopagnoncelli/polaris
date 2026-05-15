/**
 * Pure planner for Polaris ClickHouse rebuild jobs.
 *
 * Given a {@link ClickhouseRebuildDeclaration} (the operator's intent),
 * {@link planClickhouseRebuild} returns a deterministic
 * {@link ClickhouseRebuildPlan} describing exactly which projection +
 * range would be rebuilt and the rough partition / row-count
 * estimates from `system.parts`.
 *
 * **The planner is read-only.** It performs ONE optional ClickHouse
 * round-trip — the `readPartitions` adapter the caller passes in —
 * and never writes to ClickHouse. The CLI's `--dry-run` flow stops
 * here; non-dry-run `create` writes one row to
 * `clickhouse_rebuild_jobs` and stamps the planner's estimates onto
 * that row so an operator inspecting the row can see what the planner
 * saw at create time.
 *
 * Why an adapter rather than a ClickHouseOperatorClient: the planner
 * stays standalone (no operator-profile client type in its
 * dependencies, no Pino/metrics surface) and its unit tests are
 * trivial. The CLI wires the adapter to the real client; tests pass
 * an in-memory stub.
 *
 * Rejection contract:
 *
 *   - `unknown_projection`     name not in the closed set
 *   - `invalid_range`          malformed Date, partial pair, or
 *                              inverted bounds
 *   - `range_empty`            zero-width range (from === to)
 *   - `clickhouse_unreachable` no adapter supplied OR adapter threw
 *
 * The planner never emits `unknown_projection` mid-flight: it
 * validates the name before the adapter call so a missing adapter
 * combined with an unknown name surfaces the projection problem first.
 *
 * @see types.ts for input / output shapes
 * @see docs/development/clickhouse-rebuilds.md
 */

import { findRebuildableProjection, type ClickhouseProjectionDescriptor } from "./projections.js";
import type {
  ClickhouseRebuildDeclaration,
  ClickhouseRebuildPlan,
  ClickhouseRebuildPlanned,
  ClickhouseRebuildRejected,
  ClickhouseRebuildRejectionCode,
  PartsSummary,
  PlanClickhouseRebuildOptions,
} from "./types.js";

/**
 * Plan a ClickHouse projection rebuild. Returns a deterministic
 * {@link ClickhouseRebuildPlan}; never throws for operator-facing
 * input errors (those return `kind: "rejected"` with a structured
 * code instead).
 *
 * The function clones primitive fields into the output and does not
 * retain references to the input — a caller mutating the declaration
 * afterwards cannot affect a stored plan object.
 */
export async function planClickhouseRebuild(
  declaration: ClickhouseRebuildDeclaration,
  options: PlanClickhouseRebuildOptions = {},
): Promise<ClickhouseRebuildPlan> {
  const now = options.now ?? new Date();

  // ---- projection lookup --------------------------------------------
  const descriptor = findRebuildableProjection(declaration.projection);
  if (descriptor === null) {
    return reject(
      "unknown_projection",
      `unknown_projection: "${declaration.projection.trim()}" is not in the closed set of rebuildable projections. ` +
        "Add a row to `packages/shared-clickhouse/src/rebuild/projections.ts` " +
        "and ship the matching DDL under `sql/clickhouse/projections/` before rebuilding.",
    );
  }

  // ---- range bounds -------------------------------------------------
  const range = parseRange(declaration.fromTs, declaration.toTs);
  if (range.kind === "rejected") {
    return range;
  }

  // ---- adapter probe ------------------------------------------------
  if (options.readPartitions === undefined) {
    return reject(
      "clickhouse_unreachable",
      "clickhouse_unreachable: the planner needs a `readPartitions` adapter to estimate partitions. " +
        "The CLI wires this from the shared-clickhouse operator client; ensure the runner can reach ClickHouse.",
    );
  }

  let parts: PartsSummary;
  try {
    parts = await options.readPartitions({
      qualifiedTable: descriptor.qualifiedTable,
      fromTs: range.fromTs,
      toTs: range.toTs,
    });
  } catch (cause) {
    return reject(
      "clickhouse_unreachable",
      `clickhouse_unreachable: failed to read system.parts for ${descriptor.qualifiedTable}: ${formatCause(cause)}`,
    );
  }

  // ---- assemble plan ------------------------------------------------
  const partitions = parts.partitions.map((p) => ({
    partition: p.partition,
    rowsEstimated: p.rowsEstimated,
  }));
  const rowsTotalEstimated = partitions.reduce((sum, p) => sum + Math.max(0, p.rowsEstimated), 0);
  const knownGaps = dedupePreserveOrder(parts.knownGaps ?? []);

  const planned: ClickhouseRebuildPlanned = {
    kind: "planned",
    projection: descriptor.name,
    descriptor: cloneDescriptor(descriptor),
    targetTableQualified: descriptor.qualifiedTable,
    sourceRangeFrom: range.fromTs === null ? null : range.fromTs.toISOString(),
    sourceRangeTo: range.toTs === null ? null : range.toTs.toISOString(),
    partitions,
    rowsTotalEstimated,
    partitionCount: partitions.length,
    knownGaps,
    plannedAt: now.toISOString(),
    plannerVersion: "v1",
  };
  return planned;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface ParsedRange {
  readonly kind: "ok";
  readonly fromTs: Date | null;
  readonly toTs: Date | null;
}

function parseRange(
  fromInput: Date | string | null | undefined,
  toInput: Date | string | null | undefined,
): ParsedRange | ClickhouseRebuildRejected {
  const fromTs = normaliseInstant(fromInput);
  const toTs = normaliseInstant(toInput);
  if (fromTs.kind === "rejected") return fromTs;
  if (toTs.kind === "rejected") return toTs;

  if (fromTs.value === null && toTs.value === null) {
    return { kind: "ok", fromTs: null, toTs: null };
  }
  // Partial pair: one bound set, the other missing.
  if (fromTs.value === null || toTs.value === null) {
    return reject(
      "invalid_range",
      "invalid_range: both --from and --to must be supplied (full-table rebuild uses neither).",
    );
  }
  if (toTs.value.getTime() < fromTs.value.getTime()) {
    return reject(
      "invalid_range",
      `invalid_range: --to (${toTs.value.toISOString()}) precedes --from (${fromTs.value.toISOString()}).`,
    );
  }
  if (toTs.value.getTime() === fromTs.value.getTime()) {
    return reject(
      "range_empty",
      `range_empty: --from and --to are the same instant (${toTs.value.toISOString()}); a zero-width window selects no partitions.`,
    );
  }
  return { kind: "ok", fromTs: fromTs.value, toTs: toTs.value };
}

type InstantParse =
  | { readonly kind: "ok"; readonly value: Date | null }
  | ClickhouseRebuildRejected;

function normaliseInstant(input: Date | string | null | undefined): InstantParse {
  if (input === null || input === undefined) {
    return { kind: "ok", value: null };
  }
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      return reject("invalid_range", "invalid_range: range bound is not a valid Date");
    }
    return { kind: "ok", value: input };
  }
  if (typeof input !== "string") {
    return reject(
      "invalid_range",
      `invalid_range: range bound must be a Date or ISO 8601 string (got ${typeof input}).`,
    );
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { kind: "ok", value: null };
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return reject(
      "invalid_range",
      `invalid_range: range bound must be ISO 8601 (e.g. 2026-05-01T00:00:00Z); got "${trimmed}".`,
    );
  }
  return { kind: "ok", value: parsed };
}

function reject(code: ClickhouseRebuildRejectionCode, message: string): ClickhouseRebuildRejected {
  return { kind: "rejected", code, message };
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown cause";
}

function dedupePreserveOrder(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function cloneDescriptor(d: ClickhouseProjectionDescriptor): ClickhouseProjectionDescriptor {
  return {
    name: d.name,
    qualifiedTable: d.qualifiedTable,
    sqlFile: d.sqlFile,
    feederMvFile: d.feederMvFile,
    description: d.description,
  };
}
