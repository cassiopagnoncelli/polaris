#!/usr/bin/env node

// Polaris vertical-slice smoke runner — P5-001.
//
// Proves the wired path end-to-end against a running local stack:
//
//   curl POST /v1/events  ->  ingester  ->  RabbitMQ raw.events
//                          ->  analytics-projector v1
//                          ->  RabbitMQ analytics.events
//                          ->  clickhouse-sink
//                          ->  analytics_raw
//
// The script is intentionally a black-box exercise: it talks to the
// ingester over HTTPS/HTTP, then queries ClickHouse to confirm the row
// landed. It does NOT crack open the AMQP client, Redis, or PostgreSQL
// directly — the whole point is to prove the real wire path.
//
// Steps:
//
//   1. Seed: ensure the `storefront` project, the `payments-api` source,
//      and an active API key exist. Idempotent on re-runs. If the
//      environment cannot reach PostgreSQL, the seed step fails fast.
//   2. Send: post one `checkout.started` v1 event with a deterministic
//      `event_id` to `POST /v1/events` and assert the per-event response
//      reports `accepted`.
//   3. Poll: query ClickHouse `analytics_raw` for the same event_id with
//      a generous timeout (default 60s, override with
//      POLARIS_SMOKE_POLL_TIMEOUT_MS). The query uses the dedupe-safe
//      `count(DISTINCT event_id) WHERE event_id = '<id>'` shape from
//      07-clickhouse.md "Query Patterns / Pattern 4".
//   4. Verify: the matching row carries the expected
//      project/environment/event/schema_version plus the
//      `analytics-projector` v1 processor metadata.
//
// Why a plain .mjs and not the polaris CLI:
//   The CLI is the operator surface and is its own dependency graph.
//   The smoke runner ships next to clickhouse-query.mjs/clickhouse-migrate.mjs
//   so a fresh `git clone && pnpm install && docker compose up` install
//   can run it without building the whole workspace.
//
// Why not exercise the Node SDK in v1:
//   The SDK exercises its own retry/queue path; a deterministic POST
//   keeps the smoke test narrow and lets us assert exact event_id
//   propagation. SDK-driven variant is honest future work — see the
//   runbook at docs/implementation/runbooks/vertical-slice-smoke.md.
//
// Env vars (see runbook for full table):
//
//   POLARIS_INGESTER_URL          default http://localhost:8080
//   POLARIS_SMOKE_API_KEY         override the api key string; default is
//                                 to mint one via direct PostgreSQL insert
//   POLARIS_SMOKE_PROJECT_ID      default "storefront"
//   POLARIS_SMOKE_ENVIRONMENT     default "development"
//   POLARIS_SMOKE_SOURCE_ID       default "payments-api"
//   POLARIS_SMOKE_SOURCE_TYPE     default "backend"
//
//   DATABASE_URL                  required for seeding (see scripts/clickhouse-bootstrap-local.mjs
//                                 for the matching ClickHouse env var family)
//
//   CLICKHOUSE_URL                default http://localhost:8123
//   CLICKHOUSE_USER               default polaris
//   CLICKHOUSE_PASSWORD           default polaris
//
//   POLARIS_SMOKE_POLL_TIMEOUT_MS   default 60000
//   POLARIS_SMOKE_POLL_INTERVAL_MS  default 1000

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEnvelope,
  envOr,
  formatRow,
  log,
  pollClickHouseForEvent,
  postEvent,
  SmokeError,
  seedApiKey,
} from "./harness.mjs";

const __filename = fileURLToPath(import.meta.url);

/**
 * Run the smoke test. Exits the process with a non-zero status on
 * failure. Returns the assertion summary on success so tests can
 * inspect what was verified.
 */
export async function runVerticalSliceSmoke({
  ingester = {},
  clickhouse = {},
  database = {},
  smoke = {},
  logger = log,
} = {}) {
  const ingesterUrl = ingester.url ?? envOr("POLARIS_INGESTER_URL", "http://localhost:8080");
  const clickhouseClient = {
    url: (clickhouse.url ?? envOr("CLICKHOUSE_URL", "http://localhost:8123")).replace(/\/+$/, ""),
    user: clickhouse.user ?? envOr("CLICKHOUSE_USER", "polaris"),
    password: clickhouse.password ?? envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };
  const databaseUrl = database.url ?? envOr("DATABASE_URL", "");
  const projectId = smoke.projectId ?? envOr("POLARIS_SMOKE_PROJECT_ID", "storefront");
  const environment = smoke.environment ?? envOr("POLARIS_SMOKE_ENVIRONMENT", "development");
  const sourceId = smoke.sourceId ?? envOr("POLARIS_SMOKE_SOURCE_ID", "payments-api");
  const sourceType = smoke.sourceType ?? envOr("POLARIS_SMOKE_SOURCE_TYPE", "backend");
  const pollTimeoutMs = Number.parseInt(
    String(smoke.pollTimeoutMs ?? envOr("POLARIS_SMOKE_POLL_TIMEOUT_MS", "60000")),
    10,
  );
  const pollIntervalMs = Number.parseInt(
    String(smoke.pollIntervalMs ?? envOr("POLARIS_SMOKE_POLL_INTERVAL_MS", "1000")),
    10,
  );
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs <= 0) {
    throw new SmokeError("POLARIS_SMOKE_POLL_TIMEOUT_MS must be a positive integer");
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new SmokeError("POLARIS_SMOKE_POLL_INTERVAL_MS must be a positive integer");
  }

  // Allow operators to bypass the seed step entirely by exporting the
  // API key directly — useful when the local stack has already been
  // bootstrapped and PostgreSQL credentials live elsewhere.
  const providedApiKey = smoke.apiKey ?? envOr("POLARIS_SMOKE_API_KEY", "");

  logger.info(`[polaris-smoke] start`);
  logger.info(`[polaris-smoke] ingester=${ingesterUrl}`);
  logger.info(`[polaris-smoke] clickhouse=${clickhouseClient.url}`);
  logger.info(`[polaris-smoke] project=${projectId} env=${environment} source=${sourceId}`);

  // ---- step 1: seed --------------------------------------------------
  let apiKey;
  let seededInfo;
  if (providedApiKey !== "") {
    logger.info(`[polaris-smoke] step=seed mode=provided`);
    apiKey = providedApiKey;
    seededInfo = { apiKeyId: providedApiKey.split(".")[0] ?? "<provided>", seeded: false };
  } else {
    if (databaseUrl === "") {
      throw new SmokeError(
        "POLARIS_SMOKE_API_KEY is not set and DATABASE_URL is empty; cannot mint an API key. " +
          "Either export DATABASE_URL=postgres://... or POLARIS_SMOKE_API_KEY=<polaris_ak_*>.<secret>.",
      );
    }
    logger.info(`[polaris-smoke] step=seed mode=mint database=set`);
    const seeded = await seedApiKey({
      databaseUrl,
      projectId,
      environment,
      sourceId,
      sourceType,
    });
    apiKey = seeded.token;
    seededInfo = { apiKeyId: seeded.apiKeyId, seeded: true };
    logger.info(`[polaris-smoke] step=seed api_key_id=${seeded.apiKeyId}`);
  }

  // ---- step 2: build + send -----------------------------------------
  // Deterministic-ish event_id: a fresh UUIDv4 per run, but the same
  // value gets carried all the way to ClickHouse so we can assert
  // exact propagation. UUIDv4 is fine here — only the platform-issued
  // IDs need v7 ordering, smoke event_ids are throwaway.
  const eventId = randomUUID();
  const envelope = buildEnvelope({
    eventId,
    projectId,
    environment,
    sourceId,
    sourceType,
  });

  logger.info(`[polaris-smoke] step=send event_id=${eventId} event=${envelope.event}`);
  const sendResult = await postEvent({
    ingesterUrl,
    apiKey,
    envelope,
  });
  if (sendResult.kind !== "accepted") {
    throw new SmokeError(
      `[polaris-smoke] ingester did not accept the event: ${JSON.stringify(sendResult)}`,
    );
  }
  logger.info(`[polaris-smoke] step=send result=accepted status=${sendResult.status}`);

  // ---- step 3: poll ClickHouse --------------------------------------
  logger.info(
    `[polaris-smoke] step=poll target=analytics_raw event_id=${eventId} timeout_ms=${pollTimeoutMs}`,
  );
  const row = await pollClickHouseForEvent({
    client: clickhouseClient,
    eventId,
    projectId,
    environment,
    timeoutMs: pollTimeoutMs,
    intervalMs: pollIntervalMs,
    logger,
  });

  // ---- step 4: verify -----------------------------------------------
  logger.info(`[polaris-smoke] step=verify row=${formatRow(row)}`);
  const failures = [];
  if (row.event_id !== eventId) failures.push(`event_id ${row.event_id} !== ${eventId}`);
  if (row.project_id !== projectId) failures.push(`project_id ${row.project_id} !== ${projectId}`);
  if (row.environment !== environment) {
    failures.push(`environment ${row.environment} !== ${environment}`);
  }
  if (row.event !== envelope.event) failures.push(`event ${row.event} !== ${envelope.event}`);
  if (row.schema_version !== envelope.schema_version) {
    failures.push(`schema_version ${row.schema_version} !== ${envelope.schema_version}`);
  }
  if (row.processor_name !== "analytics-projector") {
    failures.push(`processor_name ${row.processor_name} !== analytics-projector`);
  }
  if (row.processor_version !== "v1") {
    failures.push(`processor_version ${row.processor_version} !== v1`);
  }
  if (failures.length > 0) {
    throw new SmokeError(
      `[polaris-smoke] row assertion(s) failed:\n  - ${failures.join("\n  - ")}`,
    );
  }

  logger.info(`[polaris-smoke] result=pass`);
  return {
    eventId,
    projectId,
    environment,
    event: envelope.event,
    schemaVersion: envelope.schema_version,
    processor: { name: row.processor_name, version: row.processor_version },
    seeded: seededInfo,
  };
}

async function main() {
  try {
    await runVerticalSliceSmoke();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    if (err instanceof Error && err.cause !== undefined) {
      process.stderr.write(`caused by: ${String(err.cause)}\n`);
    }
    process.exitCode = 1;
  }
}

// Only run when executed directly: importing the module from the vitest
// wrapper or another script must not boot a second smoke run.
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
