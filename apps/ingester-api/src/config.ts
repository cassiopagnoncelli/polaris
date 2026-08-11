import {
  composeConfigSchema,
  durationMsSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  type PostgresConfig,
  positiveIntSchema,
  postgresEnvSchema,
  type RabbitmqConfig,
  type RedisConfig,
  rabbitmqEnvSchema,
  redisEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";
import { z } from "zod";

/**
 * Tuning knobs for the in-process API key cache.
 *
 * The cache backs `apps/ingester-api/src/auth/cache.ts`. Defaults are tuned
 * for a service running thousands of requests per second against a small key
 * population (tens of keys per project) — the cache largely keeps PostgreSQL
 * out of the hot path. Redis-backed caching is a future optimisation
 * (`docs/architecture/02-control-plane.md` "Redis Role").
 *
 * Env vars:
 *
 *   POLARIS_AUTH_CACHE_MAX_ENTRIES   (1024)
 *   POLARIS_AUTH_CACHE_TTL_MS        (60000)
 *   POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS (5000)
 */
export const authCacheEnvSchema = z
  .object({
    POLARIS_AUTH_CACHE_MAX_ENTRIES: positiveIntSchema.default(1024),
    POLARIS_AUTH_CACHE_TTL_MS: durationMsSchema.default(60_000),
    POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS: durationMsSchema.default(5_000),
  })
  .transform(
    (parsed): AuthCacheConfig => ({
      maxEntries: parsed["POLARIS_AUTH_CACHE_MAX_ENTRIES"],
      ttlMs: parsed["POLARIS_AUTH_CACHE_TTL_MS"],
      negativeTtlMs: parsed["POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS"],
    }),
  );

export interface AuthCacheConfig {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly negativeTtlMs: number;
}

export const authCacheEnvKeys = [
  "POLARIS_AUTH_CACHE_MAX_ENTRIES",
  "POLARIS_AUTH_CACHE_TTL_MS",
  "POLARIS_AUTH_CACHE_NEGATIVE_TTL_MS",
] as const;

/**
 * Tuning knobs for the ingest pipeline.
 *
 * Per `04-ingestion-and-sdks.md` "Deduplication":
 *
 *   - The default ingress dedupe window is **15 minutes**. It absorbs SDK
 *     retry storms and producer outbox replays. It is **not** the canonical
 *     idempotency layer — downstream consumers must remain idempotent on
 *     their own (processor consumers key on `event_id + processor_version`,
 *     ClickHouse stores enough identifiers for `argMax` dedupe, etc.).
 *   - A project may opt in to a longer window (up to 24 hours) when its
 *     producers cannot deduplicate at the source. The opt-in is documented
 *     in the same config slot via `POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS`
 *     (comma-separated `project_id=seconds` pairs).
 *
 * Env vars:
 *
 *   POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC   (900)   default 15 min
 *   POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC       (86400) hard cap 24 h
 *   POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS      ""      e.g. "checkout=3600,marketing=86400"
 *   POLARIS_INGEST_REDIS_KEY_PREFIX            "polaris:ingest:dedupe"
 *   POLARIS_INGEST_REDIS_OP_TIMEOUT_MS         (50)    short SETNX deadline
 *   POLARIS_INGEST_MAX_BATCH_EVENTS            (1000)
 */
export const ingestEnvSchema = z
  .object({
    POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC: positiveIntSchema.default(900),
    POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC: positiveIntSchema.default(86_400),
    POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS: z.string().default(""),
    POLARIS_INGEST_REDIS_KEY_PREFIX: z.string().min(1).default("polaris:ingest:dedupe"),
    POLARIS_INGEST_REDIS_OP_TIMEOUT_MS: durationMsSchema.default(50),
    POLARIS_INGEST_MAX_BATCH_EVENTS: positiveIntSchema.default(1000),
  })
  .superRefine((parsed, ctx) => {
    if (
      parsed["POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC"] >
      parsed["POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC"]
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC"],
        message: "default dedupe window must be <= max window",
      });
    }
  })
  .transform((parsed, ctx): IngestConfig => {
    const overrides = parseProjectWindowOverrides(
      parsed["POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS"],
      parsed["POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC"],
      ctx,
    );
    return {
      defaultDedupeWindowSec: parsed["POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC"],
      maxDedupeWindowSec: parsed["POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC"],
      projectDedupeWindows: overrides,
      redisKeyPrefix: parsed["POLARIS_INGEST_REDIS_KEY_PREFIX"],
      redisOpTimeoutMs: parsed["POLARIS_INGEST_REDIS_OP_TIMEOUT_MS"],
      maxBatchEvents: parsed["POLARIS_INGEST_MAX_BATCH_EVENTS"],
    };
  });

export interface IngestConfig {
  readonly defaultDedupeWindowSec: number;
  readonly maxDedupeWindowSec: number;
  /**
   * Per-project dedupe-window overrides in seconds. Capped at
   * `maxDedupeWindowSec`. Empty by default — projects opt in to a
   * non-default window only after operational review.
   */
  readonly projectDedupeWindows: Readonly<Record<string, number>>;
  readonly redisKeyPrefix: string;
  /**
   * Short deadline applied to the dedupe SETNX call. Redis being slow must
   * not block ingestion — when the deadline trips, the ingester logs the
   * miss and accepts the event (downstream remains idempotent).
   */
  readonly redisOpTimeoutMs: number;
  readonly maxBatchEvents: number;
}

export const ingestEnvKeys = [
  "POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC",
  "POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC",
  "POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS",
  "POLARIS_INGEST_REDIS_KEY_PREFIX",
  "POLARIS_INGEST_REDIS_OP_TIMEOUT_MS",
  "POLARIS_INGEST_MAX_BATCH_EVENTS",
] as const;

/**
 * Tuning knobs for the per-API-key rate limiter (P11-006c).
 *
 * Per `docs/architecture/11-production-readiness.md` the ingester
 * caps each `api_key_id` at a configurable per-second budget so one
 * noisy SDK can't drown the broker. Per-project overrides let an
 * operator widen the budget for a known high-throughput project
 * without raising the platform default. The limiter shares the Redis
 * client with the dedupe store; a separate key prefix keeps the two
 * keyspaces disjoint.
 *
 * Env vars:
 *
 *   POLARIS_RATE_LIMIT_PER_API_KEY_RPS         (1000)   per-key request budget
 *   POLARIS_RATE_LIMIT_WINDOW_SECONDS          (1)      sliding window size
 *   POLARIS_RATE_LIMIT_PROJECT_OVERRIDES       ""       "project_id=rps,project_id=rps"
 *   POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX        "polaris:ingest:rl"
 *   POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS     (50)
 *
 * A `*_PER_API_KEY_RPS` value of 0 disables the limiter (fail-open by
 * design). Tests + smoke runs set this to keep the runtime out of the
 * way.
 */
export const rateLimitEnvSchema = z
  .object({
    POLARIS_RATE_LIMIT_PER_API_KEY_RPS: z.coerce.number().int().min(0).default(1000),
    POLARIS_RATE_LIMIT_WINDOW_SECONDS: positiveIntSchema.default(1),
    POLARIS_RATE_LIMIT_PROJECT_OVERRIDES: z.string().default(""),
    POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX: z.string().min(1).default("polaris:ingest:rl"),
    POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS: durationMsSchema.default(50),
  })
  .transform((parsed, ctx): RateLimitConfig => {
    const overrides = parseProjectRpsOverrides(parsed["POLARIS_RATE_LIMIT_PROJECT_OVERRIDES"], ctx);
    return {
      perApiKeyRps: parsed["POLARIS_RATE_LIMIT_PER_API_KEY_RPS"],
      windowSeconds: parsed["POLARIS_RATE_LIMIT_WINDOW_SECONDS"],
      projectOverrides: overrides,
      redisKeyPrefix: parsed["POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX"],
      redisOpTimeoutMs: parsed["POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS"],
    };
  });

export interface RateLimitConfig {
  readonly perApiKeyRps: number;
  readonly windowSeconds: number;
  readonly projectOverrides: Readonly<Record<string, number>>;
  readonly redisKeyPrefix: string;
  readonly redisOpTimeoutMs: number;
}

export const rateLimitEnvKeys = [
  "POLARIS_RATE_LIMIT_PER_API_KEY_RPS",
  "POLARIS_RATE_LIMIT_WINDOW_SECONDS",
  "POLARIS_RATE_LIMIT_PROJECT_OVERRIDES",
  "POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX",
  "POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS",
] as const;

function parseProjectRpsOverrides(raw: string, ctx: z.RefinementCtx): Record<string, number> {
  const out: Record<string, number> = {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return out;
  for (const entry of trimmed.split(",")) {
    const pair = entry.trim();
    if (pair.length === 0) continue;
    const equalsIndex = pair.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === pair.length - 1) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_RATE_LIMIT_PROJECT_OVERRIDES"],
        message: `expected "project_id=rps" entries, got "${pair}"`,
      });
      continue;
    }
    const projectId = pair.slice(0, equalsIndex).trim();
    const rpsRaw = pair.slice(equalsIndex + 1).trim();
    const rps = Number(rpsRaw);
    if (!Number.isInteger(rps) || rps < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_RATE_LIMIT_PROJECT_OVERRIDES"],
        message: `invalid rps for project '${projectId}': "${rpsRaw}"`,
      });
      continue;
    }
    out[projectId] = rps;
  }
  return out;
}

function parseProjectWindowOverrides(
  raw: string,
  cap: number,
  ctx: z.RefinementCtx,
): Record<string, number> {
  const out: Record<string, number> = {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return out;
  for (const entry of trimmed.split(",")) {
    const pair = entry.trim();
    if (pair.length === 0) continue;
    const equalsIndex = pair.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === pair.length - 1) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS"],
        message: `expected "project_id=seconds" entries, got "${pair}"`,
      });
      continue;
    }
    const projectId = pair.slice(0, equalsIndex).trim();
    const secondsRaw = pair.slice(equalsIndex + 1).trim();
    const seconds = Number(secondsRaw);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS"],
        message: `invalid seconds for project '${projectId}': "${secondsRaw}"`,
      });
      continue;
    }
    if (seconds > cap) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS"],
        message: `dedupe window for project '${projectId}' (${seconds}s) exceeds max (${cap}s)`,
      });
      continue;
    }
    out[projectId] = seconds;
  }
  return out;
}

/**
 * Runtime configuration for the Polaris ingester API.
 *
 * The slots are composed from the shared `@polaris/shared-config` schema
 * fragments so a single deployment template covers every dependency. The
 * ingester adds two ingester-specific groups on top: `authCache` (P2-002)
 * and `ingest` (P2-003).
 *
 * @see docs/architecture/09-engineering-standards.md "Runtime Configuration"
 */
export interface IngesterConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly postgres: PostgresConfig;
  readonly rabbitmq: RabbitmqConfig;
  readonly redis: RedisConfig;
  readonly authCache: AuthCacheConfig;
  readonly ingest: IngestConfig;
  readonly rateLimit: RateLimitConfig;
}

/**
 * The default service name surfaced when `POLARIS_SERVICE_NAME` is not set.
 *
 * The shared config schema does require `POLARIS_SERVICE_NAME`, so this constant
 * is the value the ingester deployment templates should set. It is also used
 * by `loadIngesterConfig` so the `loadConfig` error message names the service
 * concretely on misconfiguration.
 */
export const INGESTER_SERVICE_NAME = "ingester-api" as const;

/**
 * Compose the ingester config schema from shared building blocks.
 *
 * Kept as a function so tests can rebuild the schema against synthetic env
 * sources without sharing a single Zod instance across runs.
 */
export function ingesterConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    postgres: postgresEnvSchema,
    rabbitmq: rabbitmqEnvSchema,
    redis: redisEnvSchema,
    authCache: authCacheEnvSchema,
    ingest: ingestEnvSchema,
    rateLimit: rateLimitEnvSchema,
  });
}

/**
 * Load the ingester runtime config, applying the shared `.env` precedence
 * rules. Throws `ConfigValidationError` (from `@polaris/shared-config`) when
 * any required value is missing or malformed; services let that error crash
 * the process so deployments fail fast.
 */
export function loadIngesterConfig(): IngesterConfig {
  return loadConfigWithDefaults({
    serviceName: INGESTER_SERVICE_NAME,
    schema: ingesterConfigSchema(),
  });
}
