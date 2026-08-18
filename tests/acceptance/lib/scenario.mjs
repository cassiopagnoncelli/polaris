// Polaris product-acceptance scenario runner — P12-003.
//
// Implements the end-to-end happy-path acceptance test as a series of
// independent, observable steps. Each step uses ONLY production-shipped
// surfaces:
//
//   - control-plane state lives in PostgreSQL and is touched only via
//     the compiled `polaris` CLI binary;
//   - events are sent via the published `@polaris/node-sdk` (no hand-
//     crafted POSTs that bypass the SDK retry/queue path);
//   - ingestion outcome is observed through the same HTTPS reply the
//     SDK consumes (`/v1/events` accepted array) plus a direct query
//     to ClickHouse `analytics_raw` through the workspace HTTP client;
//   - replay is exercised via `polaris replay create --mode dry_run`
//     and `polaris replay plan`;
//   - delivery is observed through `polaris deliveries list` against a
//     webhook-sink destination (the only consumer that runs without a
//     vendor sandbox).
//
// Why a single .mjs harness and not a fleet of unit tests:
//
//   The acceptance test is a release gate. It is structurally distinct
//   from unit tests: it boots no fakes, mocks nothing, and asserts
//   nothing through internal helpers. The scenario reads top-to-bottom
//   so an on-call operator can scan the output and answer "is the
//   platform shipping?" in one screen.
//
// Why the steps share mutable state:
//
//   Step 4 needs the event_id minted in step 3. Step 5 needs to see
//   the row in ClickHouse before step 6 inspects a delivery record for
//   the same event. The shared `state` object is opaque to the caller
//   — it is the running tape of what the previous step produced. Steps
//   are independent in *execution* (any one can pass / fail / skip on
//   its own merits) but causally chained.
//
// @see docs/implementation/tasks/P12-003-product-acceptance-test.md
// @see docs/release/acceptance-test-runbook.md

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/**
 * Sentinel for an internal scenario failure that should mark the step
 * as `fail` (not throw out of the runner). Operators see this as a
 * "step X failed because ..." line.
 */
export class AcceptanceStepError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AcceptanceStepError";
    if (cause !== undefined) this.cause = cause;
  }
}

const DEFAULT_ENV = {
  POLARIS_INGESTER_URL: "http://localhost:4000",
  POLARIS_ACCEPTANCE_PROJECT_ID: "storefront",
  POLARIS_ACCEPTANCE_ENVIRONMENT: "development",
  POLARIS_ACCEPTANCE_SOURCE_ID: "payments-api",
  POLARIS_ACCEPTANCE_SOURCE_TYPE: "backend",
  POLARIS_ACCEPTANCE_VENDOR: "webhook",
  POLARIS_ACCEPTANCE_INSTANCE_LABEL: "acceptance-sink",
  POLARIS_ACCEPTANCE_POLL_TIMEOUT_MS: "60000",
  POLARIS_ACCEPTANCE_POLL_INTERVAL_MS: "1000",
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_USER: "polaris",
  CLICKHOUSE_PASSWORD: "polaris",
};

/**
 * Read an env var with the documented Polaris fallbacks. Mirrors the
 * vertical-slice smoke's `envOr` so operators set the same names.
 */
function envOr(env, key, fallback) {
  const fromEnv = env[key];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_ENV[key] ?? fallback;
}

/**
 * Resolve absolute paths to repo-relative artifacts the scenario reads.
 * Centralised so the runner script and the Vitest wrapper agree on
 * exact filesystem locations.
 */
export function resolveRepoArtifacts() {
  return {
    repoRoot: REPO_ROOT,
    cliBin: resolve(REPO_ROOT, "apps", "polaris-cli", "dist", "bin", "polaris.js"),
    runbook: resolve(REPO_ROOT, "docs", "release", "acceptance-test-runbook.md"),
    dlqRunbook: resolve(REPO_ROOT, "docs", "operations", "destination-dlq-triage.md"),
    backupRunbook: resolve(REPO_ROOT, "docs", "operations", "backup-and-retention.md"),
    topicIsolationRunbook: resolve(REPO_ROOT, "docs", "operations", "topic-isolation-cutover.md"),
    observabilityDoc: resolve(REPO_ROOT, "docs", "development", "observability.md"),
  };
}

/**
 * Build the canonical per-step result row.
 */
function stepResult({ id, label }) {
  const startedAt = Date.now();
  return {
    id,
    label,
    status: "pending",
    startedAt,
    finishedAt: 0,
    elapsedMs: 0,
    detail: undefined,
    error: undefined,
  };
}

function finishStep(result, status, detail, error) {
  result.status = status;
  result.detail = detail;
  result.error = error;
  result.finishedAt = Date.now();
  result.elapsedMs = result.finishedAt - result.startedAt;
  return result;
}

/**
 * Run a step body. The body either throws (status=fail), returns a
 * `{ skip: true, reason: string }` payload (status=skip), or returns a
 * plain detail value (status=pass). Throws are caught and converted to
 * a step record so the scenario keeps producing rows after a failure.
 */
async function runStep({ id, label, body, logger }) {
  const result = stepResult({ id, label });
  logger?.info(`[acceptance] step=${id} state=start label="${label}"`);
  try {
    const outcome = await body();
    if (outcome && typeof outcome === "object" && outcome.skip === true) {
      finishStep(result, "skip", outcome.reason ?? "skipped", undefined);
      logger?.info(`[acceptance] step=${id} state=skip reason="${result.detail}"`);
      return result;
    }
    finishStep(result, "pass", outcome, undefined);
    logger?.info(`[acceptance] step=${id} state=pass elapsed_ms=${result.elapsedMs}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishStep(result, "fail", undefined, message);
    logger?.error(`[acceptance] step=${id} state=fail message=${message}`);
    return result;
  }
}

/**
 * Run the entire acceptance scenario in order. Each step appends a row
 * onto `results`. Steps that depend on a prior step's output check the
 * shared `state` and short-circuit to `skip` when the dependency was
 * not satisfied — this keeps the failure surface narrow and lets the
 * operator scroll directly to the first red row.
 */
export async function runAcceptanceScenario({ env = process.env, logger } = {}) {
  const cfg = resolveConfig(env);
  const state = {
    apiKey: undefined,
    apiKeyId: undefined,
    eventId: undefined,
    destinationId: undefined,
    replayJobId: undefined,
    replayPlanJson: undefined,
    clickhouseRow: undefined,
    deliveryRecord: undefined,
    webhookHits: 0,
  };
  const results = [];

  const append = (row) => {
    results.push(row);
    return row;
  };

  // --- step 1: control plane: project + source -------------------------
  append(
    await runStep({
      id: "control_plane_catalog",
      label: "Project and source exist (polaris projects sync + sources sync)",
      logger,
      body: async () => stepEnsureCatalog(cfg),
    }),
  );

  // --- step 1b: control plane: project configuration -------------------
  append(
    await runStep({
      id: "control_plane_project_config",
      label: "Project configuration round-trips (polaris config set/list/validate)",
      logger,
      body: async () => stepProjectConfig(cfg),
    }),
  );

  // --- step 2: control plane: API key ---------------------------------
  append(
    await runStep({
      id: "control_plane_api_key",
      label: "Backend API key issued (polaris keys create)",
      logger,
      body: async () => {
        const issued = await stepIssueApiKey(cfg);
        state.apiKey = issued.token;
        state.apiKeyId = issued.api_key_id;
        return { api_key_id: issued.api_key_id };
      },
    }),
  );

  // --- step 3: webhook-sink destination (delivery target) -------------
  append(
    await runStep({
      id: "control_plane_destination",
      label: "Webhook-sink destination created + enabled (polaris destinations)",
      logger,
      body: async () => {
        if (cfg.skipDestination) {
          return { skip: true, reason: "POLARIS_ACCEPTANCE_SKIP_DESTINATION=1 set" };
        }
        const result = await stepEnsureDestination(cfg);
        state.destinationId = result.destination_id;
        return result;
      },
    }),
  );

  // --- step 4: send via Node SDK --------------------------------------
  append(
    await runStep({
      id: "sdk_track",
      label: "Node SDK posts a governed event to /v1/events",
      logger,
      body: async () => {
        if (state.apiKey === undefined) {
          return { skip: true, reason: "no API key from step 2; cannot send" };
        }
        const result = await stepSendViaNodeSdk(cfg, state.apiKey);
        state.eventId = result.event_id;
        return {
          event_id: result.event_id,
          delivered: result.delivered,
          dropped: result.dropped,
        };
      },
    }),
  );

  // --- step 5: ingestion accepted (HTTP signal) -----------------------
  append(
    await runStep({
      id: "ingestion_accepted",
      label: "Ingester returned per-event accepted for the Node SDK event",
      logger,
      body: async () => {
        if (state.eventId === undefined) {
          return { skip: true, reason: "no event_id from step 4" };
        }
        // The Node SDK's flush() result already carries delivered=1 when
        // the ingester returned per-event accepted. We surface the
        // signal explicitly so operators see the assertion in the
        // output, not implied through the SDK call.
        return { event_id: state.eventId, ingestion_signal: "accepted" };
      },
    }),
  );

  // --- step 6: processor pass -> ClickHouse analytics_raw -------------
  append(
    await runStep({
      id: "analytics_persisted",
      label: "analytics-projector v1 ran and analytics_raw observes the row",
      logger,
      body: async () => {
        if (state.eventId === undefined) {
          return { skip: true, reason: "no event_id from step 4" };
        }
        const row = await stepPollClickHouse(cfg, state.eventId);
        state.clickhouseRow = row;
        return {
          event_id: row.event_id,
          processor: `${row.processor_name}/${row.processor_version}`,
        };
      },
    }),
  );

  // --- step 7: delivery observed --------------------------------------
  append(
    await runStep({
      id: "delivery_observed",
      label: "Delivery record exists for the event on the webhook-sink destination",
      logger,
      body: async () => {
        if (cfg.skipDestination) {
          return { skip: true, reason: "POLARIS_ACCEPTANCE_SKIP_DESTINATION=1 set" };
        }
        if (state.destinationId === undefined) {
          return { skip: true, reason: "no destination_id from step 3" };
        }
        if (state.eventId === undefined) {
          return { skip: true, reason: "no event_id from step 4" };
        }
        const record = await stepInspectDeliveries(cfg, state.destinationId, state.eventId);
        state.deliveryRecord = record;
        return {
          destination_id: state.destinationId,
          delivery_id: record.delivery_id,
          status: record.status,
        };
      },
    }),
  );

  // --- step 8: replay plan (CLI dry-run) ------------------------------
  append(
    await runStep({
      id: "replay_dry_run",
      label: "polaris replay create + polaris replay plan dry-run succeed",
      logger,
      body: async () => {
        const plan = await stepReplayDryRun(cfg);
        state.replayJobId = plan.replay_job_id;
        state.replayPlanJson = plan.plan_summary;
        return {
          replay_job_id: plan.replay_job_id,
          target: plan.target,
          window_from: plan.window_from,
        };
      },
    }),
  );

  // --- step 9: runbook + dashboard links exist ------------------------
  append(
    await runStep({
      id: "release_documentation",
      label: "Acceptance runbook and operational runbooks are present and non-empty",
      logger,
      body: async () => stepAssertDocumentation(),
    }),
  );

  const verdict = results.every((r) => r.status !== "fail") ? "pass" : "fail";
  return { verdict, results, state, config: cfg };
}

/**
 * Resolve all the env-driven knobs into a single immutable config object.
 */
function resolveConfig(env) {
  const ingesterUrl = envOr(env, "POLARIS_INGESTER_URL");
  const projectId = envOr(env, "POLARIS_ACCEPTANCE_PROJECT_ID");
  const environment = envOr(env, "POLARIS_ACCEPTANCE_ENVIRONMENT");
  const sourceId = envOr(env, "POLARIS_ACCEPTANCE_SOURCE_ID");
  const sourceType = envOr(env, "POLARIS_ACCEPTANCE_SOURCE_TYPE");
  const vendor = envOr(env, "POLARIS_ACCEPTANCE_VENDOR");
  const instanceLabel = envOr(env, "POLARIS_ACCEPTANCE_INSTANCE_LABEL");
  const pollTimeoutMs = Number.parseInt(envOr(env, "POLARIS_ACCEPTANCE_POLL_TIMEOUT_MS"), 10);
  const pollIntervalMs = Number.parseInt(envOr(env, "POLARIS_ACCEPTANCE_POLL_INTERVAL_MS"), 10);
  const clickhouse = {
    url: envOr(env, "CLICKHOUSE_URL").replace(/\/+$/, ""),
    user: envOr(env, "CLICKHOUSE_USER"),
    password: envOr(env, "CLICKHOUSE_PASSWORD"),
  };
  const databaseUrl = env["DATABASE_URL"] ?? "";
  const webhookEndpoint = env["POLARIS_ACCEPTANCE_WEBHOOK_URL"] ?? "";
  const skipDestination =
    env["POLARIS_ACCEPTANCE_SKIP_DESTINATION"] === "1" || webhookEndpoint === "";
  return {
    ingesterUrl: ingesterUrl.replace(/\/+$/, ""),
    projectId,
    environment,
    sourceId,
    sourceType,
    vendor,
    instanceLabel,
    webhookEndpoint,
    skipDestination,
    pollTimeoutMs: Number.isFinite(pollTimeoutMs) && pollTimeoutMs > 0 ? pollTimeoutMs : 60_000,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 1_000,
    clickhouse,
    databaseUrl,
    artifacts: resolveRepoArtifacts(),
    env,
  };
}

// --- step bodies ------------------------------------------------------

async function stepEnsureCatalog(cfg) {
  // `polaris projects sync` and `polaris sources sync` are idempotent
  // catalog->DB materializers. The acceptance test runs them in
  // dry-run mode first (proves the CLI binary can talk to PostgreSQL
  // and read the catalog), then applies them so the rest of the
  // scenario has a real project/source pair.
  invokeCli(cfg, ["projects", "sync", "--dry-run"]);
  invokeCli(cfg, ["projects", "sync"]);
  invokeCli(cfg, ["sources", "sync", "--dry-run"]);
  invokeCli(cfg, ["sources", "sync"]);
  return {
    project_id: cfg.projectId,
    source_id: cfg.sourceId,
  };
}

/**
 * The project-configuration loop, through the real CLI against real
 * PostgreSQL.
 *
 * Everything else that covers this is either a unit test with a faked
 * database or an integration test that calls the mutation functions
 * directly. Neither exercises what an operator actually does: run the binary,
 * have it parse a value, write it through the audited transaction, and read
 * it back. A regression in argument parsing, exit codes, or the CLI's own
 * store wiring would be invisible to both.
 *
 * The value chosen is a real `ingest` key, so this also asserts that the
 * namespace the ingester reads is the namespace the CLI writes — the two
 * halves agreeing on a string is exactly the sort of thing that silently
 * stops being true.
 */
async function stepProjectConfig(cfg) {
  const NAMESPACE = "ingest";
  const KEY = "rate_limit_rps";
  const VALUE = "4242";

  invokeCli(cfg, [
    "config",
    "set",
    "--project",
    cfg.projectId,
    "--env",
    cfg.environment,
    "--namespace",
    NAMESPACE,
    "--key",
    KEY,
    "--value",
    VALUE,
    "--reason",
    "acceptance scenario",
  ]);

  const listed = invokeCli(cfg, [
    "config",
    "list",
    "--project",
    cfg.projectId,
    "--env",
    cfg.environment,
    "--output",
    "json",
  ]);
  const parsed = JSON.parse(listed);
  const stored = (parsed.values ?? []).find(
    (row) => row.namespace === NAMESPACE && row.config_key === KEY,
  );
  if (stored === undefined) {
    throw new AcceptanceStepError(
      `config list did not return ${NAMESPACE}.${KEY} after setting it`,
    );
  }
  // Parsed as JSON on the way in, so a numeric string becomes a number —
  // the behaviour an operator typing into a form or a flag expects.
  if (stored.value !== Number(VALUE)) {
    throw new AcceptanceStepError(
      `expected ${NAMESPACE}.${KEY} to be ${VALUE}, got ${JSON.stringify(stored.value)}`,
    );
  }

  // The pre-deploy gate must pass for an environment whose required keys are
  // satisfied. It exits non-zero otherwise, which invokeCli turns into a
  // step failure.
  invokeCli(cfg, ["config", "validate", "--env", cfg.environment, "--project", cfg.projectId]);

  invokeCli(cfg, [
    "config",
    "unset",
    "--project",
    cfg.projectId,
    "--env",
    cfg.environment,
    "--namespace",
    NAMESPACE,
    "--key",
    KEY,
    "--reason",
    "acceptance scenario cleanup",
  ]);

  return {
    namespace: NAMESPACE,
    config_key: KEY,
    value: stored.value,
    version: parsed.version,
  };
}

async function stepIssueApiKey(cfg) {
  // Issue a fresh backend API key per scenario run. The acceptance test
  // never reuses keys across runs: a stale revoked key would mask a
  // real ingester auth regression.
  const stdout = invokeCli(cfg, [
    "keys",
    "create",
    "--project",
    cfg.projectId,
    "--env",
    cfg.environment,
    "--source",
    cfg.sourceId,
    "--type",
    cfg.sourceType,
    "--output",
    "json",
  ]);
  const parsed = parseJsonOrThrow(stdout, "polaris keys create");
  if (typeof parsed?.token !== "string" || parsed.token.length === 0) {
    throw new AcceptanceStepError("polaris keys create did not return a token");
  }
  if (typeof parsed.api_key_id !== "string" || parsed.api_key_id.length === 0) {
    throw new AcceptanceStepError("polaris keys create did not return an api_key_id");
  }
  return { token: parsed.token, api_key_id: parsed.api_key_id };
}

async function stepEnsureDestination(cfg) {
  // webhook-sink's credential IS its target URL, so it goes in as-is. This
  // used to be wrapped as `inline:<url>` because the column held a
  // `<provider>:<ref>` pointer that a resolver unwrapped; nothing resolves
  // now, and the same URL through the old form would reach the deliverer
  // with an `inline:` prefix and fail to parse as a URL.
  const secretValue = cfg.webhookEndpoint;
  const reason = `acceptance-test-${Date.now()}`;
  let destinationId;
  try {
    const stdout = invokeCli(cfg, [
      "destinations",
      "create",
      "--project",
      cfg.projectId,
      "--env",
      cfg.environment,
      "--vendor",
      cfg.vendor,
      "--instance-label",
      cfg.instanceLabel,
      "--secret-value",
      secretValue,
      "--mode",
      "test",
      "--reason",
      reason,
      "--output",
      "json",
    ]);
    const parsed = parseJsonOrThrow(stdout, "polaris destinations create");
    destinationId = parsed?.destination_id;
  } catch (err) {
    // If the destination already exists, the CLI returns a usage error
    // (unique constraint on project/env/vendor/instance_label). The
    // acceptance test then looks the row up via `destinations list`
    // and reuses it. Idempotency lets the scenario run repeatedly
    // against the same compose stack without manual cleanup.
    const stdout = invokeCli(cfg, [
      "destinations",
      "list",
      "--project",
      cfg.projectId,
      "--env",
      cfg.environment,
      "--output",
      "json",
    ]);
    const rows = parseJsonOrThrow(stdout, "polaris destinations list");
    const list = Array.isArray(rows?.destinations) ? rows.destinations : rows;
    const match = Array.isArray(list)
      ? list.find((row) => row?.vendor === cfg.vendor && row?.instance_label === cfg.instanceLabel)
      : undefined;
    if (!match?.destination_id) {
      throw new AcceptanceStepError(
        `destinations create failed and no existing row matches vendor=${cfg.vendor} instance_label=${cfg.instanceLabel}`,
        err,
      );
    }
    destinationId = match.destination_id;
  }
  if (typeof destinationId !== "string" || destinationId.length === 0) {
    throw new AcceptanceStepError("destinations create returned no destination_id");
  }
  // Enable is idempotent — running on an already-active row prints
  // "already active" and exits 0.
  invokeCli(cfg, ["destinations", "enable", destinationId]);
  return { destination_id: destinationId };
}

async function stepSendViaNodeSdk(cfg, apiKey) {
  // Import the SDK dynamically so the harness can be loaded by tools
  // that have not built the workspace (e.g. the runner script printing
  // its banner before vitest spawns the test). The acceptance test
  // proper always loads it.
  const { PolarisNodeSdk } = await loadNodeSdk();
  const sdk = new PolarisNodeSdk({
    endpoint: `${cfg.ingesterUrl}/v1/events`,
    apiKey,
    source: {
      type: cfg.sourceType,
      id: cfg.sourceId,
      sdkVersion: "polaris-acceptance/0.0.0",
    },
    defaultContext: {},
    // Use a large batchSize so track() does NOT trigger an auto-flush;
    // the explicit `await sdk.flush()` below then performs the actual
    // drain and returns a populated FlushResult. With batchSize:1 the
    // auto-flush ran first and drained the queue, so the explicit
    // flush() chained after observed an empty queue and returned
    // delivered=0 even though the event had been delivered — the SDK
    // comment at packages/node-sdk/src/sdk.ts:238 documents the
    // contract: "track() returns once the event is durably enqueued.
    // The diagnostic onFlush callback is the right place to observe
    // outcomes."
    batchSize: 100,
    flushIntervalMs: 0,
    retry: { maxAttempts: 3 },
  });
  let dropReason;
  sdk.diagnostics?.onDrop?.((_event, reason) => {
    dropReason = reason;
  });
  try {
    const eventId = await sdk.track("checkout.started", {
      cart_id: `cart_acceptance_${randomUUID().slice(0, 8)}`,
      total: 1990,
      currency: "USD",
      items: [
        {
          sku: "acceptance-sku-1",
          name: "Acceptance Probe",
          quantity: 1,
          unit_price: 1990,
        },
      ],
    });
    const flushResult = await sdk.flush();
    if (flushResult.delivered === 0) {
      throw new AcceptanceStepError(
        `Node SDK flush() delivered=0 (dropped=${flushResult.dropped}, queued=${flushResult.queued}, drop_reason=${dropReason ?? "none"})`,
      );
    }
    return {
      event_id: eventId,
      delivered: flushResult.delivered,
      dropped: flushResult.dropped,
    };
  } finally {
    await sdk.close();
  }
}

async function stepPollClickHouse(cfg, eventId) {
  const deadline = Date.now() + cfg.pollTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const sql =
        `SELECT event_id, event, schema_version, project_id, environment, ` +
        `processor_name, processor_version ` +
        `FROM polaris.analytics_raw ` +
        `WHERE event_id = '${escapeChLiteral(eventId)}' ` +
        `AND project_id = '${escapeChLiteral(cfg.projectId)}' ` +
        `AND environment = '${escapeChLiteral(cfg.environment)}' ` +
        `LIMIT 1 SETTINGS final = 1 FORMAT JSON`;
      const result = await clickhouseQuery(cfg.clickhouse, sql);
      const row = Array.isArray(result?.data) ? result.data[0] : undefined;
      if (row && typeof row.event_id === "string" && row.event_id === eventId) {
        return {
          event_id: String(row.event_id),
          event: String(row.event ?? ""),
          schema_version: Number(row.schema_version ?? 0),
          project_id: String(row.project_id ?? ""),
          environment: String(row.environment ?? ""),
          processor_name: String(row.processor_name ?? ""),
          processor_version: String(row.processor_version ?? ""),
        };
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(cfg.pollIntervalMs);
  }
  throw new AcceptanceStepError(
    `analytics_raw did not observe event_id=${eventId} within ${cfg.pollTimeoutMs}ms` +
      (lastError ? `; last error: ${lastError.message ?? String(lastError)}` : ""),
  );
}

async function stepInspectDeliveries(cfg, destinationId, eventId) {
  // The webhook-sink consumer's delivery_records row appears on a delay
  // bounded by the consumer's poll loop. We poll just like the
  // ClickHouse step.
  const deadline = Date.now() + cfg.pollTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const stdout = invokeCli(cfg, [
        "deliveries",
        "list",
        destinationId,
        "--limit",
        "50",
        "--output",
        "json",
      ]);
      const parsed = parseJsonOrThrow(stdout, "polaris deliveries list");
      const rows = Array.isArray(parsed?.deliveries) ? parsed.deliveries : parsed;
      if (Array.isArray(rows)) {
        const match = rows.find((row) => row?.event_id === eventId);
        if (match) {
          return {
            delivery_id: String(match.delivery_id ?? ""),
            event_id: String(match.event_id ?? ""),
            status: String(match.status ?? ""),
            attempt: Number(match.attempt ?? 0),
          };
        }
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(cfg.pollIntervalMs);
  }
  throw new AcceptanceStepError(
    `no delivery record observed for event_id=${eventId} on destination_id=${destinationId} within ${cfg.pollTimeoutMs}ms` +
      (lastError ? `; last error: ${lastError.message ?? String(lastError)}` : ""),
  );
}

async function stepReplayDryRun(cfg) {
  // Construct a replay window inside the operational retention bound
  // (90 days). The window covers the last hour so the planner has a
  // realistic, narrow scope to plan against.
  const now = new Date();
  const windowTo = now.toISOString();
  const windowFrom = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const reason = `acceptance-replay-${Date.now()}`;
  const createStdout = invokeCli(cfg, [
    "replay",
    "create",
    "--project",
    cfg.projectId,
    "--env",
    cfg.environment,
    "--target",
    "processor",
    "--from",
    windowFrom,
    "--to",
    windowTo,
    "--mode",
    "dry_run",
    "--reason",
    reason,
    "--output",
    "json",
  ]);
  const created = parseJsonOrThrow(createStdout, "polaris replay create");
  if (typeof created?.replay_job_id !== "string") {
    throw new AcceptanceStepError("polaris replay create did not return replay_job_id");
  }
  const planStdout = invokeCli(cfg, ["replay", "plan", created.replay_job_id, "--output", "json"]);
  const plan = parseJsonOrThrow(planStdout, "polaris replay plan");
  return {
    replay_job_id: created.replay_job_id,
    target: created.target ?? "processor",
    window_from: windowFrom,
    plan_summary: plan,
  };
}

async function stepAssertDocumentation() {
  const artifacts = resolveRepoArtifacts();
  const docs = [
    { id: "acceptance_runbook", path: artifacts.runbook },
    { id: "dlq_triage_runbook", path: artifacts.dlqRunbook },
    { id: "backup_retention_runbook", path: artifacts.backupRunbook },
    { id: "topic_isolation_runbook", path: artifacts.topicIsolationRunbook },
    { id: "observability_runbook", path: artifacts.observabilityDoc },
  ];
  const missing = [];
  for (const doc of docs) {
    if (!existsSync(doc.path)) {
      missing.push(`${doc.id} (${doc.path}) is missing`);
      continue;
    }
    const stat = statSync(doc.path);
    if (stat.size < 64) {
      missing.push(`${doc.id} (${doc.path}) is suspiciously small (size=${stat.size})`);
    }
  }
  if (missing.length > 0) {
    throw new AcceptanceStepError(`documentation gaps:\n  - ${missing.join("\n  - ")}`);
  }
  return { docs: docs.map((d) => d.id) };
}

// --- helpers ----------------------------------------------------------

/**
 * Spawn the compiled `polaris` CLI and return stdout. Throws an
 * AcceptanceStepError on non-zero exit, including stderr in the
 * message so operators see the underlying CLI complaint without
 * tailing a log file.
 *
 * The binary is read from `apps/polaris-cli/dist/bin/polaris.js` so
 * the acceptance test exercises the same artifact that `pnpm install
 * --prod` would ship. We do not `pnpm exec polaris` because that
 * resolves through .bin shims and obscures which JS file actually
 * runs.
 */
export function invokeCli(cfg, args) {
  const artifacts = cfg.artifacts ?? resolveRepoArtifacts();
  if (!existsSync(artifacts.cliBin)) {
    throw new AcceptanceStepError(
      `polaris CLI binary not built at ${artifacts.cliBin}. Run \`pnpm -r build\` first.`,
    );
  }
  const result = spawnSync(process.execPath, [artifacts.cliBin, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (result.error) {
    throw new AcceptanceStepError(
      `polaris ${args.join(" ")} spawn failed: ${result.error.message}`,
      result.error,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdoutTail = (result.stdout ?? "").trim().split("\n").slice(-5).join("\n");
    throw new AcceptanceStepError(
      `polaris ${args.join(" ")} exited ${result.status}: ${stderr}\n` +
        (stdoutTail ? `last stdout lines:\n${stdoutTail}` : ""),
    );
  }
  return result.stdout ?? "";
}

function parseJsonOrThrow(stdout, label) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new AcceptanceStepError(`${label} produced empty stdout`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new AcceptanceStepError(
      `${label} produced non-JSON output: ${trimmed.slice(0, 256)}`,
      err,
    );
  }
}

async function loadNodeSdk() {
  // The acceptance test imports the SDK from the workspace by name —
  // exactly what an internal team's package.json would do. We do NOT
  // reach into ./packages/node-sdk/src by relative path because that
  // would skip the published `dist/` artifact and let the test pass
  // even if the SDK is broken at the published entry point.
  return import("@polaris/node-sdk");
}

async function clickhouseQuery(client, sql) {
  const auth = `Basic ${Buffer.from(`${client.user}:${client.password}`).toString("base64")}`;
  const resp = await fetch(`${client.url}/`, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      authorization: auth,
    },
    body: sql,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new AcceptanceStepError(`ClickHouse ${resp.status} ${resp.statusText}: ${text.trim()}`);
  }
  if (text === "") return { data: [] };
  return JSON.parse(text);
}

function escapeChLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a human-readable summary table for the runner script and the
 * Vitest reporter. Uses fixed column widths so the table looks the
 * same on every terminal and gates can scrape it with awk if needed.
 */
export function renderResultsTable(results) {
  const header = "STATUS  STEP                            ELAPSED   LABEL".trimEnd();
  const lines = [header, "------- ------------------------------- --------- -----"];
  for (const r of results) {
    const status = padRight(r.status.toUpperCase(), 7);
    const id = padRight(r.id.slice(0, 31), 31);
    const elapsed = padRight(`${r.elapsedMs}ms`, 9);
    lines.push(`${status} ${id} ${elapsed} ${r.label}`);
    if (r.status === "fail" && r.error !== undefined) {
      const indented = String(r.error)
        .split("\n")
        .map((s) => `        ${s}`)
        .join("\n");
      lines.push(indented);
    }
  }
  return lines.join("\n");
}

function padRight(s, n) {
  if (s.length >= n) return s.slice(0, n);
  return s + " ".repeat(n - s.length);
}

/**
 * Read the package.json at the repo root to surface the harness's
 * version string in the runner banner. Not load-bearing — falls back
 * to 0.0.0 if the file is unreadable.
 */
export function readRepoVersion() {
  try {
    const content = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    const parsed = JSON.parse(content);
    return typeof parsed?.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
