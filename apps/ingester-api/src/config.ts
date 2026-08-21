import {
  booleanFromStringSchema,
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
} from "@polaris/runtime-config";
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
 *   - A project may opt in to a longer window (up to the cap below) when its
 *     producers cannot deduplicate at the source. That opt-in now lives in
 *     `project_config[ingest].dedupe_window_sec`, not in this file — see
 *     `src/project-config.ts`. The cap stays here on purpose: a project must
 *     not be able to raise its own ceiling.
 *
 * Env vars:
 *
 *   POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC   (900)   default 15 min
 *   POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC       (86400) hard cap 24 h
 *   POLARIS_INGEST_REDIS_KEY_PREFIX            "polaris:ingest:dedupe"
 *   POLARIS_INGEST_REDIS_OP_TIMEOUT_MS         (50)    short SETNX deadline
 *   POLARIS_INGEST_MAX_BATCH_EVENTS            (1000)
 *   POLARIS_INGEST_STAMP_CLIENT_CONTEXT        (true)  stamp ip + user agent
 *   POLARIS_INGEST_FORWARDED_TRUST_DEPTH       (0)     trusted proxies in front
 *
 * The last two govern the client-context stamp — see
 * `src/ingest/client-context.ts` for the rules and
 * `docs/deployment/config-reference.md` for the operator-facing rows.
 */
export const ingestEnvSchema = z
  .object({
    POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC: positiveIntSchema.default(900),
    POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC: positiveIntSchema.default(86_400),
    POLARIS_INGEST_REDIS_KEY_PREFIX: z.string().min(1).default("polaris:ingest:dedupe"),
    POLARIS_INGEST_REDIS_OP_TIMEOUT_MS: durationMsSchema.default(50),
    POLARIS_INGEST_MAX_BATCH_EVENTS: positiveIntSchema.default(1000),
    POLARIS_INGEST_STAMP_CLIENT_CONTEXT: booleanFromStringSchema.default(true),
    // `min(0)` rather than `positiveIntSchema`: 0 is the DEFAULT and means
    // "trust no proxy, use the socket peer", so the value this knob is most
    // often set to is the one a positive-int schema would reject.
    POLARIS_INGEST_FORWARDED_TRUST_DEPTH: z.coerce.number().int().min(0).default(0),
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
  .transform((parsed): IngestConfig => {
    return {
      defaultDedupeWindowSec: parsed["POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC"],
      maxDedupeWindowSec: parsed["POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC"],
      redisKeyPrefix: parsed["POLARIS_INGEST_REDIS_KEY_PREFIX"],
      redisOpTimeoutMs: parsed["POLARIS_INGEST_REDIS_OP_TIMEOUT_MS"],
      maxBatchEvents: parsed["POLARIS_INGEST_MAX_BATCH_EVENTS"],
      stampClientContext: parsed["POLARIS_INGEST_STAMP_CLIENT_CONTEXT"],
      forwardedTrustDepth: parsed["POLARIS_INGEST_FORWARDED_TRUST_DEPTH"],
    };
  });

export interface IngestConfig {
  readonly defaultDedupeWindowSec: number;
  readonly maxDedupeWindowSec: number;
  readonly redisKeyPrefix: string;
  /**
   * Short deadline applied to the dedupe SETNX call. Redis being slow must
   * not block ingestion — when the deadline trips, the ingester logs the
   * miss and accepts the event (downstream remains idempotent).
   */
  readonly redisOpTimeoutMs: number;
  readonly maxBatchEvents: number;
  /**
   * Whether the ingester fills `context.ip` / `context.user_agent` from the
   * connection for browser- and mobile-typed keys. On by default; an
   * operator who must not collect addresses in an environment turns it off
   * there. It does not disable the `0.0.0.0` opt-out, which only ever
   * removes data — see `src/ingest/client-context.ts`.
   */
  readonly stampClientContext: boolean;
  /**
   * How many trusted proxies sit in front of the ingester. `0` (the
   * default) reads the socket peer and ignores `X-Forwarded-For` entirely;
   * `n` takes the n-th address from the right of that chain.
   */
  readonly forwardedTrustDepth: number;
}

export const ingestEnvKeys = [
  "POLARIS_INGEST_DEDUPE_DEFAULT_WINDOW_SEC",
  "POLARIS_INGEST_DEDUPE_MAX_WINDOW_SEC",
  "POLARIS_INGEST_REDIS_KEY_PREFIX",
  "POLARIS_INGEST_REDIS_OP_TIMEOUT_MS",
  "POLARIS_INGEST_MAX_BATCH_EVENTS",
  "POLARIS_INGEST_STAMP_CLIENT_CONTEXT",
  "POLARIS_INGEST_FORWARDED_TRUST_DEPTH",
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
    POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX: z.string().min(1).default("polaris:ingest:rl"),
    POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS: durationMsSchema.default(50),
  })
  .transform((parsed): RateLimitConfig => {
    return {
      perApiKeyRps: parsed["POLARIS_RATE_LIMIT_PER_API_KEY_RPS"],
      windowSeconds: parsed["POLARIS_RATE_LIMIT_WINDOW_SECONDS"],
      redisKeyPrefix: parsed["POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX"],
      redisOpTimeoutMs: parsed["POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS"],
    };
  });

export interface RateLimitConfig {
  readonly perApiKeyRps: number;
  readonly windowSeconds: number;
  readonly redisKeyPrefix: string;
  readonly redisOpTimeoutMs: number;
}

export const rateLimitEnvKeys = [
  "POLARIS_RATE_LIMIT_PER_API_KEY_RPS",
  "POLARIS_RATE_LIMIT_WINDOW_SECONDS",
  "POLARIS_RATE_LIMIT_REDIS_KEY_PREFIX",
  "POLARIS_RATE_LIMIT_REDIS_OP_TIMEOUT_MS",
] as const;

/**
 * Runtime configuration for the Polaris ingester API.
 *
 * The slots are composed from the shared `@polaris/runtime-config` schema
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
 * rules. Throws `ConfigValidationError` (from `@polaris/runtime-config`) when
 * any required value is missing or malformed; services let that error crash
 * the process so deployments fail fast.
 */
export function loadIngesterConfig(): IngesterConfig {
  return loadConfigWithDefaults({
    serviceName: INGESTER_SERVICE_NAME,
    schema: ingesterConfigSchema(),
  });
}
