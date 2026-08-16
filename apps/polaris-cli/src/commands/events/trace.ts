/**
 * `polaris events trace <event_id> --project X` — read-only.
 *
 * "Where is my event." Four stores already know part of the answer and
 * nobody could ask them in one breath:
 *
 *   - the quarantine (`polaris.violations`)        did it get in at all?
 *   - `polaris.analytics_ingest_log`               which families, partitions,
 *                                                  offsets, and processor
 *                                                  stamps did it pass through?
 *   - `delivery_records`                           which destinations tried,
 *                                                  and what happened?
 *   - `dlq_records`                                did any of them give up?
 *
 * This command joins them into one timeline. It adds no storage and
 * discovers nothing new — every fact was already written down; the value
 * is that answering the question stops requiring four commands and a
 * mental model of which store holds what.
 *
 * ## Absent is not an error
 *
 * A trace has to work against partial topologies. Pre-R2 deployments have
 * no `resolved.events` rows; an event that was rejected has no delivery
 * records; an event that arrived thirty seconds ago may not have reached
 * ClickHouse yet. Every stage renders as `absent` with a reason rather
 * than throwing, because an operator running this is already debugging
 * and a stack trace is not an answer. The one true error is an event_id
 * no store has heard of at all.
 *
 * ## Why `--project` is required
 *
 * `analytics_ingest_log` is `ORDER BY (project_id, environment,
 * ingested_at, event_id)`. Without a project the event_id predicate
 * cannot use the sort key and the query degrades to a full scan of the
 * 30-day retention window. The flag is the difference between a key
 * lookup and a table scan, so it is required rather than optional-with-a-
 * warning — the warning would be read after the scan had already started.
 *
 * ## Retention
 *
 * The ingest-log half of the answer is bounded by that table's 30-day
 * TTL. The Postgres halves are not. So "no ingest-log rows" for an event
 * older than 30 days means "aged out", not "never arrived", and the
 * output says so rather than leaving the operator to remember it.
 *
 * ## Secrets
 *
 * None are reachable. `delivery_records` carries no resolved secret, the
 * violation sample was redacted in the ingester before publish, and this
 * command prints no event payload — `properties` is deliberately not
 * selected. `events tail` is where payloads are displayed, and it
 * truncates and redacts them there.
 *
 * `mutates: false`: bypasses the production gate from P6-007.
 */

import {
  createClickHouseClient,
  INGEST_LOG_TRACE_MAX_LIMIT,
  type IngestLogTraceRow,
  type ViolationRow,
} from "@polaris/shared-clickhouse";
import {
  createKyselyDeliveryRecordRepository,
  createKyselyDlqRecordRepository,
  type DeliveryRecord,
  type DlqRecord,
} from "@polaris/shared-destinations";
import type { Command } from "commander";

import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_DATABASE_ENV = "POLARIS_CLICKHOUSE_DATABASE";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_SERVICE_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_SERVICE_PASSWORD";

/** Retention of `analytics_ingest_log`, per `sql/clickhouse/20_*.sql`. */
const INGEST_LOG_RETENTION_DAYS = 30;

export interface EventsTraceArgs {
  readonly eventId: string;
  readonly project: string;
  readonly environment?: string;
  readonly limit?: number;
}

/**
 * The four reads a trace makes. Split behind one interface so tests drive
 * the whole command with an in-memory double and no live stores.
 */
export interface EventsTraceStore {
  ingestLog(args: EventsTraceArgs): Promise<readonly IngestLogTraceRow[]>;
  violations(args: EventsTraceArgs): Promise<readonly ViolationRow[]>;
  deliveries(eventId: string): Promise<readonly DeliveryRecord[]>;
  dlq(eventId: string): Promise<readonly DlqRecord[]>;
  close(): Promise<void>;
}

export interface EventsTraceHooks {
  readonly openStore?: (ctx: CommandContext) => EventsTraceStore;
}

export const eventsTraceCommand: CommandDefinition = {
  id: "events.trace",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("trace <event_id>")
      .description(
        "Join ingest, transport lineage, processor stamps, deliveries and DLQ into one timeline for a single event.",
      )
      .requiredOption(
        "--project <project_id>",
        "Project the event belongs to. Required: it is the ingest-log sort key, and omitting it turns a key lookup into a full scan.",
      )
      .option("--env <environment>", "Narrow to one environment.")
      .option("--limit <n>", "Max ingest-log rows to read.", (raw: string) =>
        Number.parseInt(raw, 10),
      );
    cmd.action(
      async (
        eventId: string,
        opts: { project: string; env?: string; limit?: number },
        command: Command,
      ) => {
        const wrapped = deps.runCommand<EventsTraceArgs>(
          { id: "events.trace", mutates: false },
          runEventsTrace,
        );
        await wrapped(
          {
            eventId,
            project: opts.project,
            ...(opts.env !== undefined ? { environment: opts.env } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          },
          command,
        );
      },
    );
  },
};

export function buildEventsTraceRunner(hooks: EventsTraceHooks = {}) {
  return async function runner(args: EventsTraceArgs, ctx: CommandContext): Promise<undefined> {
    const eventId = args.eventId.trim();
    if (eventId.length === 0) {
      throw new UsageError("event_id is required");
    }
    const project = args.project.trim();
    if (project.length === 0) {
      throw new UsageError("--project is required and cannot be empty");
    }
    if (args.limit !== undefined) {
      if (!Number.isInteger(args.limit) || args.limit <= 0) {
        throw new UsageError("--limit must be a positive integer");
      }
      if (args.limit > INGEST_LOG_TRACE_MAX_LIMIT) {
        throw new UsageError(`--limit cannot exceed ${INGEST_LOG_TRACE_MAX_LIMIT}`);
      }
    }

    const normalized: EventsTraceArgs = {
      eventId,
      project,
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    };

    const openStore = hooks.openStore ?? defaultStore;
    const store = openStore(ctx);

    let trace: EventTrace;
    try {
      // Sequential, not concurrent: two of these are Postgres on one pool
      // and two are ClickHouse, and a trace is an interactive command
      // where the shape of the failure matters more than 40ms. A
      // Promise.all here would report one store's outage as the whole
      // command failing with whichever error lost the race.
      const violations = await store.violations(normalized);
      const ingestLog = await store.ingestLog(normalized);
      const deliveries = await store.deliveries(eventId);
      const dlq = await store.dlq(eventId);
      trace = assemble(normalized, { violations, ingestLog, deliveries, dlq });
    } finally {
      await store.close();
    }

    if (trace.found === false) {
      throw new UsageError(
        `event "${eventId}" not found in project "${project}" — no quarantine record, no ingest-log row, no delivery, no DLQ entry. ${trace.retention_note}`,
      );
    }

    ctx.output.writeOut(
      renderAccordingTo(ctx.config.output, {
        human: renderHuman(trace),
        json: { trace },
      }),
    );
    return undefined;
  };
}

const runEventsTrace = buildEventsTraceRunner();

// ---------------------------------------------------------------------------
// The assembled shape
// ---------------------------------------------------------------------------

/** A stage that either happened, or provably did not, or cannot be known. */
export type StagePresence = "present" | "absent";

export interface TraceStage<T> {
  readonly presence: StagePresence;
  /** Why the stage is absent. Empty when present. */
  readonly note: string;
  readonly rows: readonly T[];
}

/**
 * A DLQ record as a trace reports it.
 *
 * `DlqRecord` carries `payload` — the raw event bytes, kept so
 * `polaris dlq retry` can republish them — and `headers`. Neither belongs
 * in a trace: the payload is the event's data in full, unredacted, and
 * this command's contract is that it prints no event payload. So the row
 * is projected onto the triage-relevant fields here rather than filtered
 * at the render layer, because `--output json` bypasses the renderer and
 * would have shipped the bytes.
 */
export interface TracedDlqRecord {
  readonly dlq_id: string;
  readonly destination_id: string;
  readonly vendor: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class: string | null;
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly published_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

function toTracedDlqRecord(row: DlqRecord): TracedDlqRecord {
  return {
    dlq_id: row.dlq_id,
    destination_id: row.destination_id,
    vendor: row.vendor,
    attempts: row.attempts,
    reason: row.reason,
    error_class: row.error_class,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    published_at: row.published_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolved_by: row.resolved_by,
  };
}

/**
 * A quarantine row as a trace reports it.
 *
 * `redacted_sample` is dropped. It is redacted — the ingester saw to that
 * before publishing — but it is still the shape of the event that was
 * rejected, and a trace answers "did this get in", not "what did they
 * send". `polaris violations list` is the command that shows samples, and
 * keeping the sample in exactly one place keeps its handling reviewable.
 */
export interface TracedViolation {
  readonly violation_id: string;
  readonly event: string;
  readonly reason: string;
  readonly paths: readonly string[];
  readonly received_at: string;
}

function toTracedViolation(row: ViolationRow): TracedViolation {
  return {
    violation_id: row.violation_id,
    event: row.event,
    reason: row.reason,
    paths: row.paths,
    received_at: row.received_at,
  };
}

export interface EventTrace {
  readonly event_id: string;
  readonly project_id: string;
  readonly environment: string | null;
  /** False when no store has heard of this event at all. */
  readonly found: boolean;
  /** Always printed — the ingest-log half of the answer is TTL-bounded. */
  readonly retention_note: string;
  readonly quarantine: TraceStage<TracedViolation>;
  readonly ingest_log: TraceStage<IngestLogTraceRow>;
  readonly deliveries: TraceStage<DeliveryRecord>;
  readonly dlq: TraceStage<TracedDlqRecord>;
}

interface RawReads {
  readonly violations: readonly ViolationRow[];
  readonly ingestLog: readonly IngestLogTraceRow[];
  readonly deliveries: readonly DeliveryRecord[];
  readonly dlq: readonly DlqRecord[];
}

/**
 * Fold the four reads into the reported trace.
 *
 * Pure, and takes no clock: every timestamp in the output came from a
 * store. A `now` was threaded through here at first and never read —
 * the retention note is a fixed statement about the table's TTL, not a
 * computed age, so there was nothing for it to do.
 */
function assemble(args: EventsTraceArgs, reads: RawReads): EventTrace {
  const found =
    reads.violations.length > 0 ||
    reads.ingestLog.length > 0 ||
    reads.deliveries.length > 0 ||
    reads.dlq.length > 0;

  const rejected = reads.violations.length > 0;

  return {
    event_id: args.eventId,
    project_id: args.project,
    environment: args.environment ?? null,
    found,
    retention_note: `analytics_ingest_log retains ${INGEST_LOG_RETENTION_DAYS} days; absent transport lineage for an older event means aged out, not never arrived.`,
    quarantine: stage(reads.violations.map(toTracedViolation), "event was not rejected at ingest"),
    ingest_log: stage(
      reads.ingestLog,
      rejected
        ? "event was rejected at ingest, so it never reached the spine"
        : "no transport lineage in the retention window",
    ),
    deliveries: stage(
      reads.deliveries,
      rejected
        ? "event was rejected at ingest, so no destination saw it"
        : "no destination has attempted this event",
    ),
    dlq: stage(reads.dlq.map(toTracedDlqRecord), "no destination dead-lettered this event"),
  };
}

function stage<T>(rows: readonly T[], absentNote: string): TraceStage<T> {
  if (rows.length > 0) return { presence: "present", note: "", rows };
  return { presence: "absent", note: absentNote, rows: [] };
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

function renderHuman(trace: EventTrace): string {
  const lines: string[] = [];
  lines.push(`event ${trace.event_id}`);
  lines.push(`  project      ${trace.project_id}`);
  lines.push(`  environment  ${trace.environment ?? "(any)"}`);
  lines.push("");

  lines.push(section("INGEST", trace.quarantine.presence === "present" ? "REJECTED" : "accepted"));
  if (trace.quarantine.presence === "present") {
    for (const row of trace.quarantine.rows) {
      lines.push(`  ${row.received_at}  reason=${row.reason}  event=${row.event}`);
      if (row.paths.length > 0) lines.push(`    paths: ${row.paths.join(", ")}`);
    }
  } else {
    lines.push(`  ${trace.quarantine.note}`);
  }
  lines.push("");

  lines.push(section("TRANSPORT + PROCESSORS", presenceLabel(trace.ingest_log)));
  if (trace.ingest_log.presence === "present") {
    for (const row of trace.ingest_log.rows) {
      const stamp =
        row.processor_name.length > 0
          ? `${row.processor_name}@${row.processor_version}`
          : "(unstamped)";
      lines.push(
        `  ${row.ingested_at}  ${row._topic}[${row._partition}]@${String(row._offset)}  ${stamp}`,
      );
    }
  } else {
    lines.push(`  ${trace.ingest_log.note}`);
  }
  lines.push("");

  lines.push(section("DELIVERIES", presenceLabel(trace.deliveries)));
  if (trace.deliveries.presence === "present") {
    for (const row of trace.deliveries.rows) {
      lines.push(
        `  ${row.finished_at.toISOString()}  ${row.destination_id}  attempt=${String(row.attempt)}  ${row.status}${
          row.error_class === null ? "" : `  error=${row.error_class}`
        }`,
      );
    }
  } else {
    lines.push(`  ${trace.deliveries.note}`);
  }
  lines.push("");

  lines.push(section("DLQ", presenceLabel(trace.dlq)));
  if (trace.dlq.presence === "present") {
    for (const row of trace.dlq.rows) {
      lines.push(
        `  ${row.dlq_id}  ${row.destination_id}  attempts=${String(row.attempts)}  reason=${row.reason}${
          row.resolved_at === null ? "" : "  (resolved)"
        }`,
      );
    }
  } else {
    lines.push(`  ${trace.dlq.note}`);
  }
  lines.push("");
  lines.push(trace.retention_note);

  return lines.join("\n");
}

function section(title: string, status: string): string {
  return `${title}: ${status}`;
}

function presenceLabel(stage: TraceStage<unknown>): string {
  return stage.presence === "present" ? `${String(stage.rows.length)} record(s)` : "absent";
}

// ---------------------------------------------------------------------------
// Production store
// ---------------------------------------------------------------------------

function defaultStore(ctx: CommandContext): EventsTraceStore {
  const env = ctx.env;
  const url = env[CLICKHOUSE_URL_ENV];
  const database = env[CLICKHOUSE_DATABASE_ENV];
  const username = env[CLICKHOUSE_USER_ENV];
  const password = env[CLICKHOUSE_PASSWORD_ENV];
  if (
    url === undefined ||
    database === undefined ||
    username === undefined ||
    password === undefined
  ) {
    throw new UsageError(
      `${CLICKHOUSE_URL_ENV}, ${CLICKHOUSE_DATABASE_ENV}, ${CLICKHOUSE_USER_ENV} and ${CLICKHOUSE_PASSWORD_ENV} are required to read the ingest log and the quarantine.`,
    );
  }

  const ch = createClickHouseClient({
    role: "service",
    url,
    database,
    credential: { username, password },
    application: "polaris-cli",
  });
  const handle = connectDb({ env });
  const deliveryRepo = createKyselyDeliveryRecordRepository({ db: handle.db });
  const dlqRepo = createKyselyDlqRecordRepository({ db: handle.db });

  return {
    ingestLog: (args) =>
      ch.ingestLog.trace({
        eventId: args.eventId,
        projectId: args.project,
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      }),
    violations: async (args) => {
      const rows = await ch.violations.list({
        projectId: args.project,
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
      });
      // The violations reader filters by project and window, not by
      // event_id — a rejected event has no canonical envelope, so the id
      // is a field on the wrapper rather than a sort key. Narrowing here
      // is the honest cost of that.
      return rows.filter((row) => row.event_id === args.eventId);
    },
    deliveries: (eventId) => deliveryRepo.findRecordsByEventId(eventId),
    dlq: (eventId) => dlqRepo.findByEventId(eventId),
    close: async () => {
      await ch.close();
      await handle.close();
    },
  };
}
