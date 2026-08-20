/**
 * Processor run registration.
 *
 * Per `docs/architecture/05-processors-and-replay.md` "Processors and
 * Replay", every processor execution is tracked as a `processor_runs` row
 * in PostgreSQL. The row carries enough lineage information for replay,
 * audit, and incident triage:
 *
 *   - immutable identity:    (processor_name, processor_version)
 *   - scope:                  (project, environment) where applicable
 *   - lifecycle:              status + timestamps
 *   - operational metrics:    events_consumed / emitted / failed, last_offset
 *   - host:                   pod / hostname for triage
 *   - failure summary:        a short error string when the run failed
 *
 * The repository surface in this module is intentionally small: register a
 * run on startup, increment counters and update the offset as messages flow,
 * complete or fail the run on shutdown / fatal error. Implementations:
 *
 *   - `InMemoryProcessorRunRepository` — for tests and bootstrap scenarios
 *     where no PostgreSQL is available yet.
 *   - `createKyselyProcessorRunRepository` — production binding against
 *     `@polaris/shared-db`'s typed `Kysely<Database>`.
 *
 * Both implementations satisfy the `ProcessorRunRepository` contract so
 * callers do not have to branch on transport. Concrete processors pick the
 * Kysely repo at boot and pass the same handle to runtime/helper code.
 *
 * @see db/postgres/migrations/20260512000007_create_processor_runs.sql
 * @see docs/architecture/05-processors-and-replay.md
 */

import type { Database } from "@polaris/shared-db";
import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";

/**
 * Closed set of processor run lifecycle states.
 *
 * Transitions:
 *   - `running` -> `completed` (graceful stop, no fatal error)
 *   - `running` -> `failed`    (fatal error caught by the runtime)
 *   - `running` -> `cancelled` (operator-issued stop)
 *
 * `completed` / `failed` / `cancelled` are terminal. The repository rejects
 * transitions out of a terminal state to avoid losing the original cause.
 */
export const PROCESSOR_RUN_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type ProcessorRunStatus = (typeof PROCESSOR_RUN_STATUSES)[number];

/**
 * Per-run counters and metadata. Persisted on the row through periodic
 * `updateRun` calls. The values are informational — the Kafka committed
 * offset remains the authoritative checkpoint.
 */
export interface ProcessorRunCounters {
  readonly events_consumed?: number | undefined;
  readonly events_emitted?: number | undefined;
  readonly events_failed?: number | undefined;
  /**
   * Last RabbitMQ offset observed by the run. Persisted for diagnostics.
   * The Kafka consumer group offset is the authoritative checkpoint; this
   * column is operator-facing.
   */
  readonly last_offset?: number | bigint | string | undefined;
}

/** Input accepted by `registerRun`. */
export interface RegisterRunInput {
  readonly processor_name: string;
  readonly processor_version: string;
  /** Optional project scope. Some processors run cross-project; leave undefined. */
  readonly project_id?: string | undefined;
  /** Optional environment scope. Closed set per `Environment` in shared-db. */
  readonly environment?: string | undefined;
  /** Optional pod / hostname for triage. */
  readonly host?: string | undefined;
  /**
   * Explicit `started_at`. Defaults to `now()` from the repository. Tests
   * use the override for deterministic assertions.
   */
  readonly started_at?: Date | undefined;
  /**
   * Explicit run id. When omitted the repository allocates a UUIDv7.
   * Provided as an escape hatch for replay tooling that wants to use a
   * pre-allocated id for cross-table joining.
   */
  readonly run_id?: string | undefined;
}

/** Input accepted by `completeRun`. */
export interface CompleteRunInput extends ProcessorRunCounters {
  readonly run_id: string;
  /** Optional terminal timestamp; defaults to `now()`. */
  readonly finished_at?: Date | undefined;
}

/** Input accepted by `failRun`. */
export interface FailRunInput extends ProcessorRunCounters {
  readonly run_id: string;
  /**
   * Short summary string. Implementations truncate; the full stack trace
   * belongs in logs, not the run row.
   */
  readonly error_summary: string;
  readonly finished_at?: Date | undefined;
}

/** Input accepted by `cancelRun`. */
export interface CancelRunInput extends ProcessorRunCounters {
  readonly run_id: string;
  readonly reason?: string | undefined;
  readonly finished_at?: Date | undefined;
}

/** Input accepted by `updateRun`. */
export interface UpdateRunInput extends ProcessorRunCounters {
  readonly run_id: string;
}

/**
 * In-memory view of a `processor_runs` row. Mirrors the typed
 * `ProcessorRunsTable` schema in `@polaris/shared-db` but uses plain JS
 * types so callers do not have to map Kysely's `ColumnType` helpers.
 */
export interface ProcessorRunRecord {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly status: ProcessorRunStatus;
  readonly events_consumed: number;
  readonly events_emitted: number;
  readonly events_failed: number;
  readonly last_offset: bigint | null;
  readonly host: string | null;
  readonly error_summary: string | null;
}

/**
 * Repository contract.
 *
 * The contract is deliberately small. Implementations are free to batch
 * updates (the in-memory adapter is synchronous; the Kysely adapter issues
 * one `UPDATE` per call). Callers should not invoke `updateRun` per
 * message — once per heartbeat is the intended cadence.
 */
export interface ProcessorRunRepository {
  registerRun(input: RegisterRunInput): Promise<ProcessorRunRecord>;
  updateRun(input: UpdateRunInput): Promise<ProcessorRunRecord>;
  completeRun(input: CompleteRunInput): Promise<ProcessorRunRecord>;
  failRun(input: FailRunInput): Promise<ProcessorRunRecord>;
  cancelRun(input: CancelRunInput): Promise<ProcessorRunRecord>;
  /**
   * Read back a run by id. Used by tests and replay tooling. Returns
   * `null` when the run is unknown.
   */
  findRun(run_id: string): Promise<ProcessorRunRecord | null>;
}

/**
 * Error thrown when a state transition would lose information (e.g.
 * completing a run that already failed). The repository surfaces this so
 * tests catch programmer mistakes deterministically; production runtimes
 * should treat it as a fatal log-and-continue.
 */
export class InvalidRunTransitionError extends Error {
  public override readonly name = "InvalidRunTransitionError";
  public readonly run_id: string;
  public readonly current_status: ProcessorRunStatus;
  public readonly attempted_status: ProcessorRunStatus;

  constructor(
    run_id: string,
    current_status: ProcessorRunStatus,
    attempted_status: ProcessorRunStatus,
  ) {
    super(
      `Cannot transition run ${run_id} from ${current_status} to ${attempted_status}: ` +
        "terminal statuses are immutable.",
    );
    this.run_id = run_id;
    this.current_status = current_status;
    this.attempted_status = attempted_status;
  }
}

// ---------------------------------------------------------------------------
// In-memory adapter
// ---------------------------------------------------------------------------

/**
 * Options accepted by the in-memory adapter. The `now` slot makes lifecycle
 * timestamps deterministic in tests.
 */
export interface InMemoryProcessorRunRepositoryOptions {
  readonly now?: () => Date;
}

/**
 * Pure in-memory `ProcessorRunRepository`. Suitable for unit tests, the
 * smoke harness, and bootstrap scenarios that run before PostgreSQL is
 * available.
 *
 * The adapter enforces the same status-transition rules as the SQL adapter
 * so tests fail loudly when the runtime would corrupt a real row.
 */
export class InMemoryProcessorRunRepository implements ProcessorRunRepository {
  private readonly records = new Map<string, ProcessorRunRecord>();
  private readonly now: () => Date;

  constructor(options: InMemoryProcessorRunRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async registerRun(input: RegisterRunInput): Promise<ProcessorRunRecord> {
    const run_id = input.run_id ?? uuidv7();
    const startedAt = input.started_at ?? this.now();
    const record: ProcessorRunRecord = {
      run_id,
      processor_name: input.processor_name,
      processor_version: input.processor_version,
      project_id: input.project_id ?? null,
      environment: input.environment ?? null,
      started_at: startedAt,
      finished_at: null,
      status: "running",
      events_consumed: 0,
      events_emitted: 0,
      events_failed: 0,
      last_offset: null,
      host: input.host ?? null,
      error_summary: null,
    };
    this.records.set(run_id, record);
    return record;
  }

  async updateRun(input: UpdateRunInput): Promise<ProcessorRunRecord> {
    const current = this.requireRecord(input.run_id);
    const next: ProcessorRunRecord = {
      ...current,
      events_consumed: input.events_consumed ?? current.events_consumed,
      events_emitted: input.events_emitted ?? current.events_emitted,
      events_failed: input.events_failed ?? current.events_failed,
      last_offset: normalizeOffset(input.last_offset, current.last_offset),
    };
    this.records.set(input.run_id, next);
    return next;
  }

  async completeRun(input: CompleteRunInput): Promise<ProcessorRunRecord> {
    return this.transition(input.run_id, "completed", input);
  }

  async failRun(input: FailRunInput): Promise<ProcessorRunRecord> {
    return this.transition(input.run_id, "failed", input, {
      error_summary: input.error_summary,
    });
  }

  async cancelRun(input: CancelRunInput): Promise<ProcessorRunRecord> {
    return this.transition(input.run_id, "cancelled", input, {
      error_summary: input.reason ?? null,
    });
  }

  async findRun(run_id: string): Promise<ProcessorRunRecord | null> {
    return this.records.get(run_id) ?? null;
  }

  /** Snapshot the entire store. Useful for tests. */
  snapshot(): ReadonlyArray<ProcessorRunRecord> {
    return Array.from(this.records.values());
  }

  private requireRecord(run_id: string): ProcessorRunRecord {
    const current = this.records.get(run_id);
    if (current === undefined) {
      throw new Error(`unknown processor run id: ${run_id}`);
    }
    return current;
  }

  private transition(
    run_id: string,
    target: ProcessorRunStatus,
    counters: ProcessorRunCounters & { finished_at?: Date | undefined },
    extra: { error_summary?: string | null } = {},
  ): ProcessorRunRecord {
    const current = this.requireRecord(run_id);
    if (current.status !== "running") {
      throw new InvalidRunTransitionError(run_id, current.status, target);
    }
    const next: ProcessorRunRecord = {
      ...current,
      status: target,
      finished_at: counters.finished_at ?? this.now(),
      events_consumed: counters.events_consumed ?? current.events_consumed,
      events_emitted: counters.events_emitted ?? current.events_emitted,
      events_failed: counters.events_failed ?? current.events_failed,
      last_offset: normalizeOffset(counters.last_offset, current.last_offset),
      error_summary:
        extra.error_summary !== undefined ? extra.error_summary : current.error_summary,
    };
    this.records.set(run_id, next);
    return next;
  }
}

function normalizeOffset(
  next: ProcessorRunCounters["last_offset"],
  current: bigint | null,
): bigint | null {
  if (next === undefined) return current;
  if (next === null) return null;
  if (typeof next === "bigint") return next;
  if (typeof next === "number") return BigInt(next);
  if (typeof next === "string") {
    if (next.length === 0) return current;
    try {
      return BigInt(next);
    } catch {
      return current;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Kysely-backed adapter
// ---------------------------------------------------------------------------

/**
 * Options for the SQL-backed repository. `now` makes the lifecycle
 * timestamps deterministic in integration tests; production passes the
 * default and PostgreSQL's `now()` defaults take over on inserted rows.
 */
export interface KyselyProcessorRunRepositoryOptions {
  readonly db: Kysely<Database>;
  readonly now?: () => Date;
}

/**
 * Build a Kysely-backed `ProcessorRunRepository`. Implements the same
 * contract as the in-memory adapter.
 *
 * The migration owning the table is
 * `db/postgres/migrations/20260512000007_create_processor_runs.sql`.
 */
export function createKyselyProcessorRunRepository(
  options: KyselyProcessorRunRepositoryOptions,
): ProcessorRunRepository {
  const { db } = options;
  const now = options.now ?? (() => new Date());

  async function registerRun(input: RegisterRunInput): Promise<ProcessorRunRecord> {
    const run_id = input.run_id ?? uuidv7();
    const startedAt = input.started_at ?? now();
    const inserted = await db
      .insertInto("processor_runs")
      .values({
        run_id,
        processor_name: input.processor_name,
        processor_version: input.processor_version,
        project_id: input.project_id ?? null,
        environment: input.environment ?? null,
        started_at: startedAt,
        status: "running",
        events_consumed: 0,
        events_emitted: 0,
        events_failed: 0,
        last_offset: null,
        host: input.host ?? null,
        error_summary: null,
        finished_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(inserted);
  }

  async function updateRun(input: UpdateRunInput): Promise<ProcessorRunRecord> {
    const updates: Record<string, unknown> = {};
    if (input.events_consumed !== undefined) updates["events_consumed"] = input.events_consumed;
    if (input.events_emitted !== undefined) updates["events_emitted"] = input.events_emitted;
    if (input.events_failed !== undefined) updates["events_failed"] = input.events_failed;
    if (input.last_offset !== undefined) {
      updates["last_offset"] = serializeOffset(input.last_offset);
    }
    if (Object.keys(updates).length === 0) {
      return requireFound(await findRun(input.run_id), input.run_id);
    }
    const updated = await db
      .updateTable("processor_runs")
      .set(updates)
      .where("run_id", "=", input.run_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(updated);
  }

  async function completeRun(input: CompleteRunInput): Promise<ProcessorRunRecord> {
    return transition(input.run_id, "completed", input, {});
  }

  async function failRun(input: FailRunInput): Promise<ProcessorRunRecord> {
    return transition(input.run_id, "failed", input, { error_summary: input.error_summary });
  }

  async function cancelRun(input: CancelRunInput): Promise<ProcessorRunRecord> {
    return transition(input.run_id, "cancelled", input, { error_summary: input.reason ?? null });
  }

  async function findRun(run_id: string): Promise<ProcessorRunRecord | null> {
    const row = await db
      .selectFrom("processor_runs")
      .selectAll()
      .where("run_id", "=", run_id)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async function transition(
    run_id: string,
    target: ProcessorRunStatus,
    counters: ProcessorRunCounters & { finished_at?: Date | undefined },
    extra: { error_summary?: string | null },
  ): Promise<ProcessorRunRecord> {
    const current = await findRun(run_id);
    if (current === null) {
      throw new Error(`unknown processor run id: ${run_id}`);
    }
    if (current.status !== "running") {
      throw new InvalidRunTransitionError(run_id, current.status, target);
    }
    const updates: Record<string, unknown> = {
      status: target,
      finished_at: counters.finished_at ?? now(),
    };
    if (counters.events_consumed !== undefined)
      updates["events_consumed"] = counters.events_consumed;
    if (counters.events_emitted !== undefined) updates["events_emitted"] = counters.events_emitted;
    if (counters.events_failed !== undefined) updates["events_failed"] = counters.events_failed;
    if (counters.last_offset !== undefined) {
      updates["last_offset"] = serializeOffset(counters.last_offset);
    }
    if (extra.error_summary !== undefined) updates["error_summary"] = extra.error_summary;
    const row = await db
      .updateTable("processor_runs")
      .set(updates)
      .where("run_id", "=", run_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  return { registerRun, updateRun, completeRun, failRun, cancelRun, findRun };
}

function serializeOffset(value: ProcessorRunCounters["last_offset"]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  return value;
}

function requireFound(record: ProcessorRunRecord | null, run_id: string): ProcessorRunRecord {
  if (record === null) {
    throw new Error(`unknown processor run id: ${run_id}`);
  }
  return record;
}

interface ProcessorRunRow {
  run_id: string;
  processor_name: string;
  processor_version: string;
  project_id: string | null;
  environment: string | null;
  started_at: Date;
  finished_at: Date | null;
  status: string;
  events_consumed: number;
  events_emitted: number;
  events_failed: number;
  last_offset: bigint | number | string | null;
  host: string | null;
  error_summary: string | null;
}

function toRecord(row: ProcessorRunRow): ProcessorRunRecord {
  return {
    run_id: row.run_id,
    processor_name: row.processor_name,
    processor_version: row.processor_version,
    project_id: row.project_id,
    environment: row.environment,
    started_at: row.started_at,
    finished_at: row.finished_at,
    status: asStatus(row.status),
    events_consumed: row.events_consumed,
    events_emitted: row.events_emitted,
    events_failed: row.events_failed,
    last_offset: normalizeOffsetFromRow(row.last_offset),
    host: row.host,
    error_summary: row.error_summary,
  };
}

function asStatus(value: string): ProcessorRunStatus {
  if ((PROCESSOR_RUN_STATUSES as ReadonlyArray<string>).includes(value)) {
    return value as ProcessorRunStatus;
  }
  // The CHECK constraint on the table rejects anything else; the cast
  // remains so a corrupted row produces a typed value rather than throwing
  // at the call site.
  return "running";
}

function normalizeOffsetFromRow(value: bigint | number | string | null): bigint | null {
  if (value === null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") {
    if (value.length === 0) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}
