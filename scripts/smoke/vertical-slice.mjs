#!/usr/bin/env node

// Polaris vertical-slice smoke runner — P5-001.
//
// Proves the wired path end-to-end against a running local stack:
//
//   curl POST /v1/events  ->  ingester  ->  RabbitMQ raw.events
//                          ->  sync/identity/resolver  (the SPINE)
//                          ->  RabbitMQ identified.events
//                          ->  sync/enrichment
//                          ->  RabbitMQ resolved.events
//                          ->  clickhouse-sink
//                          ->  analytics_raw  (carrying a profile_id)
//
// It proved the LEGACY path until 2026-08-17, asserting
// `processor_name === "analytics-projector"` — the feed 126EPNIQ exists
// to retire. That is why nobody noticed the identity stage threw on
// every event it ever saw, for the three days between shipping and being
// fixed: the only end-to-end test in the repo was busy confirming the
// thing we are removing still works.
//
// The assertion that matters now is `profile_id`. Resolving one is the
// identity stage's entire job and the projector cannot produce one, so a
// populated value is proof the event crossed the spine — a stronger claim
// than any processor-name string, which a passthrough could fake.
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
//      project/environment/event/schema_version AND a non-empty
//      `profile_id`, which only the spine can supply.
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
//   POLARIS_SMOKE_API_KEY         override the api key string. Unset, the
//                                 backend token in blueprints/api-key is used
//                                 when `bin/setup` has issued one; failing
//                                 that, one is minted by direct PG insert
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
import { existsSync, readFileSync } from "node:fs";
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

/** Where `bin/setup` writes the tokens it issues. */
const ISSUED_KEY_FILE = resolve(__filename, "../../../blueprints/api-key");

/**
 * The backend token `bin/setup` issued, if there is one.
 *
 * The smoke test's default source (`payments-api`, backend) is the same one
 * the install issues a backend key for, so on a machine that has run `make
 * setup` there is already a real key for exactly this path — no reason to
 * mint a second. Returns "" when the file is absent, which is the CI case
 * and any stack brought up without `bin/setup`; the mint path below still
 * covers those.
 */
function readIssuedBackendKey() {
  if (!existsSync(ISSUED_KEY_FILE)) return "";
  for (const line of readFileSync(ISSUED_KEY_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("POLARIS_BACKEND_API_KEY=")) {
      return trimmed.slice("POLARIS_BACKEND_API_KEY=".length).trim();
    }
  }
  return "";
}

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
  const providedApiKey = smoke.apiKey ?? envOr("POLARIS_SMOKE_API_KEY", "") ?? "";
  const issuedApiKey = providedApiKey === "" ? readIssuedBackendKey() : "";

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
  } else if (issuedApiKey !== "") {
    // `bin/setup` already issued a backend key for this exact source. Using
    // it means the smoke run proves the key the install produced actually
    // works, instead of proving that a key this script minted for itself
    // does — which is the more useful assertion, and one less place that
    // knows how to create catalog rows.
    logger.info(`[polaris-smoke] step=seed mode=issued source=blueprints/api-key`);
    apiKey = issuedApiKey;
    seededInfo = { apiKeyId: issuedApiKey.split(".")[0] ?? "<issued>", seeded: false };
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
  // The spine assertion. An empty profile_id means the event reached
  // ClickHouse by the legacy fan-out, or that the identity stage is down
  // and something else wrote the row — both of which look like a healthy
  // pipeline from every other angle.
  if (typeof row.profile_id !== "string" || row.profile_id.length === 0) {
    failures.push(
      "profile_id is empty — the event did not cross the identity stage. " +
        "Check that sync-identity is running and consuming raw.events.\n" +
        "  NOT an activation problem: the gate is open unless an explicit " +
        "`disabled` row exists (packages/shared-processor/src/" +
        "activation-gate.ts), so there is no row to go and create. This " +
        "message used to say the opposite, which would have sent you to " +
        "write rows that do nothing — and under the wrong name besides, " +
        "since the gate keys on the manifest's `sync-identity-resolver`.",
    );
  }
  if (row.processor_name === "analytics-projector") {
    failures.push(
      "processor_name is analytics-projector — the row came from the legacy " +
        "fan-out this smoke test used to assert. The spine did not produce it.",
    );
  }
  if (failures.length > 0) {
    throw new SmokeError(
      `[polaris-smoke] row assertion(s) failed:\n  - ${failures.join("\n  - ")}`,
    );
  }

  logger.info(`[polaris-smoke] result=pass profile_id=${row.profile_id}`);
  return {
    eventId,
    projectId,
    environment,
    event: envelope.event,
    schemaVersion: envelope.schema_version,
    processor: { name: row.processor_name, version: row.processor_version },
    profileId: row.profile_id,
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
