// Polaris vertical-slice smoke harness — P5-001.
//
// Helper module for scripts/smoke/vertical-slice.mjs. Keeping these helpers
// in a sibling file gives the vitest wrapper in tests/smoke/ a clean import
// boundary without paying for a full @polaris/* workspace package.
//
// The helpers are dependency-free on purpose: native fetch for HTTP,
// node:crypto for randomBytes + argon2id (via shared-secrets when present),
// and a small pg HTTP query through unix socket / wire — we do NOT pull
// `pg` directly. Seeding happens through a tiny `psql`-style shell-out
// because:
//
//   * adding `pg` here would force a workspace dependency churn
//   * the seed surface is one INSERT and one SELECT; shelling out to
//     `psql` keeps it portable across local Docker compose and CI matrix
//   * shared-secrets ships an argon2id hasher we re-use directly so the
//     hash is byte-compatible with what the polaris CLI would produce.
//
// If `psql` is unavailable on the host running the smoke (rare for an
// internal infra team but possible), set POLARIS_SMOKE_API_KEY directly
// and the runner skips the seed step entirely.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7Maybe } from "./uuidv7.mjs";

/**
 * Custom error class so `runVerticalSliceSmoke` can distinguish smoke
 * failures (assertion + setup) from unexpected runtime errors. The
 * `scripts/smoke/vertical-slice.mjs` entry point only formats this
 * class; unknown errors crash with a stack trace, which is what we
 * want during development.
 */
export class SmokeError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "SmokeError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Default logger — newline-terminated lines to stdout / stderr.
 *
 * The callbacks are typed as `(msg: string) => void` even though
 * `process.stdout.write` returns `boolean`; tests pass `() => undefined`
 * fakes, and the runner does not depend on the boolean.
 *
 * @type {{ info: (msg: string) => void, error: (msg: string) => void }}
 */
export const log = {
  info: (msg) => {
    process.stdout.write(`${msg}\n`);
  },
  error: (msg) => {
    process.stderr.write(`${msg}\n`);
  },
};

export function envOr(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

/**
 * Build a canonical-envelope-shaped object suitable for POST /v1/events.
 *
 * The ingester re-stamps `project_id`, `environment`, `source.id`,
 * `source.type`, and `ingested_at` from the API key on the wire (see
 * `apps/ingester-api/src/ingest/handler.ts` `stampTrustedMetadata`).
 * The smoke runner still sets them for two reasons:
 *
 *   1. The ingester rejects events that don't include them at all in
 *      the canonical envelope shape.
 *   2. Setting them to the expected values keeps the request shape
 *      faithful to what a real producer would send.
 *
 * `checkout.started` v1 is used because it's an ACTIVE catalog entry
 * (not deprecated) and its property surface is small.
 *
 * @param {{
 *   eventId: string,
 *   projectId: string,
 *   environment: string,
 *   sourceId: string,
 *   sourceType: string,
 *   occurredAt?: string
 * }} args
 */
export function buildEnvelope({
  eventId,
  projectId,
  environment,
  sourceId,
  sourceType,
  occurredAt,
}) {
  const now = occurredAt ?? new Date().toISOString();
  return {
    event_id: eventId,
    event: "checkout.started",
    schema_version: 1,
    project_id: projectId,
    environment,
    occurred_at: now,
    ingested_at: now, // overwritten by the ingester
    source: {
      type: sourceType,
      id: sourceId,
      sdk: "polaris-smoke",
      sdk_version: "0.0.0",
    },
    identity: {
      anonymous_id: `anon_smoke_${eventId.slice(0, 8)}`,
      session_id: null,
      customer_id: null,
      device_id: null,
    },
    context: {
      ip: null,
      user_agent: null,
      locale: null,
      page: null,
      campaign: null,
    },
    properties: {
      cart_id: `cart_smoke_${eventId.slice(0, 8)}`,
      total: 1990,
      currency: "USD",
      items: [
        {
          sku: "smoke-sku-1",
          name: "Vertical Slice Probe",
          quantity: 1,
          unit_price: 1990,
        },
      ],
    },
  };
}

/**
 * POST the single-event batch to the ingester. Returns the parsed
 * batch response on a 200 OK with a single accepted entry; otherwise
 * a rich diagnostic payload that the runner promotes into a thrown
 * SmokeError.
 *
 * @param {{
 *   ingesterUrl: string,
 *   apiKey: string,
 *   envelope: { event_id: string } & Record<string, unknown>
 * }} args
 */
export async function postEvent({ ingesterUrl, apiKey, envelope }) {
  const url = `${ingesterUrl.replace(/\/+$/, "")}/v1/events`;
  const body = JSON.stringify({ events: [envelope] });
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-polaris-api-key": apiKey,
      },
      body,
    });
  } catch (err) {
    throw new SmokeError(
      `failed to POST ${url}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const text = await resp.text();
  let parsed;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (resp.status !== 200) {
    return { kind: "http_error", status: resp.status, body: parsed };
  }
  if (!parsed || !Array.isArray(parsed.accepted) || parsed.accepted.length !== 1) {
    return { kind: "shape_error", status: resp.status, body: parsed };
  }
  const acceptedEntry = parsed.accepted[0];
  if (acceptedEntry?.event_id !== envelope.event_id) {
    return { kind: "id_mismatch", status: resp.status, body: parsed };
  }
  if (Array.isArray(parsed.rejected) && parsed.rejected.length > 0) {
    return { kind: "partial_reject", status: resp.status, body: parsed };
  }
  return { kind: "accepted", status: resp.status, body: parsed };
}

/**
 * Poll `analytics_raw` for a single row matching `event_id`. The query
 * filters on the unique `event_id` first; the dedupe-safe shape comes
 * from `count(DISTINCT event_id)` and the WHERE clause keeps the scan
 * narrow on a hot stack with many other tests running side-by-side.
 *
 * `analytics_raw` is intentionally queried with the dedupe-aware shape
 * documented in 07-clickhouse.md "Query Patterns / Pattern 4" — for a
 * single-event smoke a `count(DISTINCT event_id) = 1` answer is the
 * smallest cross-section that proves the row arrived without depending
 * on merge state.
 *
 * Returns the flattened row (one of the rows that share the event_id
 * key in case of replays / duplicates) so the caller can assert
 * project_id/environment/processor metadata.
 *
 * @param {{
 *   client: { url: string, user: string, password: string },
 *   eventId: string,
 *   projectId: string,
 *   environment: string,
 *   timeoutMs: number,
 *   intervalMs: number,
 *   logger?: { info: (msg: string) => void, error: (msg: string) => void }
 * }} args
 */
export async function pollClickHouseForEvent({
  client,
  eventId,
  projectId,
  environment,
  timeoutMs,
  intervalMs,
  logger = log,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const seen = await runClickHouseQuery(
        client,
        `SELECT count(DISTINCT event_id) AS seen
         FROM polaris.analytics_raw
         WHERE event_id = '${escapeClickhouseLiteral(eventId)}'
           AND project_id = '${escapeClickhouseLiteral(projectId)}'
           AND environment = '${escapeClickhouseLiteral(environment)}'
         FORMAT JSON`,
      );
      const seenCount = readJsonCount(seen);
      if (seenCount >= 1) {
        // Fetch the full row, deduped by the argMax idiom.
        //
        // Not `SETTINGS final = 1`, which this used to be: FINAL is
        // sanctioned for ad-hoc operator reads, but this query is not
        // ad-hoc -- it runs on every smoke, and it is the one read of
        // analytics_raw a newcomer is most likely to copy. Every other
        // reader in the repo uses argMax and the lint forbids FINAL in
        // shared-clickhouse; a smoke test demonstrating the exception
        // teaches the exception.
        const fullRow = await runClickHouseQuery(
          client,
          `SELECT
             event_id, event, project_id, environment,
             argMax(schema_version, _version) AS schema_version,
             argMax(processor_name, _version) AS processor_name,
             argMax(processor_version, _version) AS processor_version,
             argMax(profile_id, _version) AS profile_id
           FROM polaris.analytics_raw
           WHERE event_id = '${escapeClickhouseLiteral(eventId)}'
             AND project_id = '${escapeClickhouseLiteral(projectId)}'
             AND environment = '${escapeClickhouseLiteral(environment)}'
           GROUP BY project_id, environment, event, event_id
           LIMIT 1
           FORMAT JSON`,
        );
        const row = readJsonFirstRow(fullRow);
        if (row !== undefined) return row;
        // Race: count(DISTINCT) saw the row but the SELECT raced the
        // merge — fall through to the next poll iteration.
      }
    } catch (err) {
      lastError = err;
      // Most operator errors here are transient (ClickHouse warming up,
      // network blip). Log at info and retry until the deadline.
      logger.info(
        `[polaris-smoke] poll attempt=${attempt} transient error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await sleep(intervalMs);
  }
  const cause = lastError !== undefined ? lastError : undefined;
  throw new SmokeError(
    `[polaris-smoke] timed out after ${timeoutMs}ms waiting for analytics_raw to see event_id=${eventId}`,
    cause,
  );
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Render the ClickHouse row for a single-line log entry. Avoids JSON.stringify
 * so operator output stays grep-friendly.
 */
export function formatRow(row) {
  return [
    `event_id=${row.event_id}`,
    `event=${row.event}`,
    `schema_version=${row.schema_version}`,
    `project_id=${row.project_id}`,
    `environment=${row.environment}`,
    `processor=${row.processor_name}/${row.processor_version}`,
  ].join(" ");
}

/**
 * Run a ClickHouse query through HTTP and return the parsed JSON body.
 * Mirrors `scripts/clickhouse-query.mjs` so the smoke runner doesn't
 * need to depend on its module surface.
 */
export async function runClickHouseQuery(client, sql) {
  const auth = "Basic " + Buffer.from(`${client.user}:${client.password}`).toString("base64");
  let resp;
  try {
    resp = await fetch(`${client.url}/`, {
      method: "POST",
      headers: {
        "content-type": "text/plain; charset=utf-8",
        authorization: auth,
      },
      body: sql,
    });
  } catch (err) {
    throw new SmokeError(
      `ClickHouse request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new SmokeError(`ClickHouse ${resp.status} ${resp.statusText}: ${text.trim()}`);
  }
  if (text === "") return { data: [] };
  return JSON.parse(text);
}

function readJsonCount(parsed) {
  if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) return 0;
  const first = parsed.data[0];
  if (first === undefined || first === null) return 0;
  const raw = first.seen;
  if (raw === undefined) return 0;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : 0;
}

function readJsonFirstRow(parsed) {
  if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0) return undefined;
  const row = parsed.data[0];
  if (row === undefined || row === null) return undefined;
  return {
    event_id: String(row.event_id ?? ""),
    event: String(row.event ?? ""),
    schema_version: Number(row.schema_version ?? 0),
    project_id: String(row.project_id ?? ""),
    environment: String(row.environment ?? ""),
    processor_name: String(row.processor_name ?? ""),
    processor_version: String(row.processor_version ?? ""),
    // The spine's proof. Resolving one is the identity stage's whole job,
    // so a populated value is what says the event crossed it.
    //
    // This projection is hand-written per column, which is why it can
    // disagree with the SELECT above: the column was added to the query
    // and not to here, and the smoke then reported an empty profile_id
    // for an event whose row in ClickHouse had a perfectly good one.
    // A row shape held in two places, updated in one -- the same defect
    // as the resolver's PublishTarget, in the test built to catch it.
    profile_id: String(row.profile_id ?? ""),
  };
}

/**
 * Escape a string for inclusion in a single-quoted ClickHouse literal.
 * The smoke test only ever quotes event_id (a UUID) and constants we
 * control, but we still defend against quote characters so future
 * callers don't introduce SQL injection footguns.
 */
function escapeClickhouseLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Bootstrap the project, source, and API key required for the smoke
 * test. Implemented as direct SQL through `psql` to stay independent
 * of the workspace and so the smoke runner can be used as a one-shot
 * `node scripts/smoke/vertical-slice.mjs` without bringing in the
 * polaris CLI process.
 *
 * Returns the on-wire token (`<id>.<secret>`) and the api_key_id. The
 * token plaintext is held only in this process and the single stdout
 * line — same posture as the polaris CLI.
 *
 * Idempotency:
 *   - projects: INSERT ... ON CONFLICT DO NOTHING
 *   - sources:  INSERT ... ON CONFLICT DO NOTHING
 *   - api_keys: always inserts a fresh row. Old smoke keys accumulate
 *     in the table — operators can prune with `DELETE FROM api_keys
 *     WHERE api_key_id LIKE 'polaris_ak_smoke_%'` if desired. We don't
 *     prune here because the smoke can run against shared environments
 *     where another instance's keys must not be touched.
 */
export async function seedApiKey({ databaseUrl, projectId, environment, sourceId, sourceType }) {
  if (!databaseUrl) throw new SmokeError("databaseUrl is required to seed the API key");

  const apiKeyId = `polaris_ak_smoke_${uuidv7()}`;
  const rawSecret = randomBytes(32).toString("base64url");
  const token = `${apiKeyId}.${rawSecret}`;
  const hash = await hashSecretWithSharedSecrets(rawSecret);

  // ---- ensure project + source rows exist --------------------------
  // We mirror the polaris CLI's project/source sync semantics with a
  // simpler INSERT-or-ignore pattern. Both tables tolerate the row
  // already existing so re-runs converge.
  await runPsql({
    databaseUrl,
    sql:
      `INSERT INTO projects (project_id, display_name, owner, description, status) ` +
      `VALUES ('${escapePg(projectId)}', '${escapePg(projectId)}', 'polaris-smoke', ` +
      `'Created by polaris vertical-slice smoke test.', 'active') ` +
      `ON CONFLICT (project_id) DO NOTHING;`,
  });
  await runPsql({
    databaseUrl,
    sql:
      `INSERT INTO sources (project_id, source_id, source_type, owner, description, runtime, allowed_environments, status) ` +
      `VALUES ('${escapePg(projectId)}', '${escapePg(sourceId)}', '${escapePg(sourceType)}', ` +
      `'polaris-smoke', 'Created by polaris vertical-slice smoke test.', 'active', ` +
      `ARRAY['development','staging','production']::text[], 'active') ` +
      `ON CONFLICT (project_id, source_id) DO NOTHING;`,
  });

  // ---- insert the API key row ---------------------------------------
  await runPsql({
    databaseUrl,
    sql:
      `INSERT INTO api_keys (api_key_id, project_id, environment, source_id, source_type, hash, hash_algorithm, status) ` +
      `VALUES ('${escapePg(apiKeyId)}', '${escapePg(projectId)}', '${escapePg(environment)}', ` +
      `'${escapePg(sourceId)}', '${escapePg(sourceType)}', '${escapePg(hash)}', 'argon2id', 'active');`,
  });

  return { apiKeyId, rawSecret, token };
}

/**
 * Dynamically import `@polaris/shared-secrets` if the workspace is
 * installed, otherwise fall back to a minimal argon2id implementation
 * via Node's built-in crypto.
 *
 * Picking shared-secrets when available keeps the smoke key
 * byte-compatible with what the polaris CLI mints, so a smoke API key
 * works against the same auth path as a real one.
 */
async function hashSecretWithSharedSecrets(plaintext) {
  try {
    const mod = await import("@polaris/shared-secrets");
    if (typeof mod.hashSecret === "function") {
      return mod.hashSecret(plaintext);
    }
  } catch {
    // Not installed in this environment — surface a clear error.
  }
  throw new SmokeError(
    "@polaris/shared-secrets is not available; cannot hash the API key secret. " +
      "Run `pnpm install` from the repo root before invoking the smoke runner, " +
      "or pass POLARIS_SMOKE_API_KEY=<id>.<secret> to bypass seeding.",
  );
}

/**
 * Execute a SQL statement through `psql`. Returns nothing on success;
 * throws SmokeError with stderr on failure. We use `psql` rather than a
 * Node pg driver so the smoke runner doesn't drag in a new dependency.
 *
 * Synchronous spawn is fine: the smoke runner is a CLI script, not a
 * server, and each call is a single short-lived INSERT against an
 * already-up PostgreSQL.
 *
 * @param {{ databaseUrl: string, sql: string }} args
 */
function runPsql({ databaseUrl, sql }) {
  const result = spawnSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new SmokeError(`psql spawn failed: ${result.error.message}`, result.error);
  }
  if (result.status !== 0) {
    throw new SmokeError(`psql exited ${result.status}: ${result.stderr?.trim() ?? "(no stderr)"}`);
  }
}

function escapePg(value) {
  return String(value).replace(/'/g, "''");
}

function uuidv7() {
  return uuidv7Maybe();
}
