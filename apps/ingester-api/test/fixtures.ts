/**
 * Shared test fixtures.
 *
 * Tests import these to avoid duplicating the slightly fiddly
 * `IngesterConfig`, repository, and dedupe scaffolding across every spec.
 */

import {
  buildCatalog,
  type CatalogEntryFile,
  defaultSchemaBindings,
  type EventCatalog,
  envelopeSchema,
} from "@polaris/spec";
import type { ApiKeyRecord, ApiKeyRepository } from "../src/auth/repository.js";
import type { IngesterConfig } from "../src/config.js";
import type { DedupeClaimInput, DedupeClaimOutcome, DedupeStore } from "../src/dedupe/index.js";

export const testConfig: IngesterConfig = {
  service: {
    serviceName: "ingester-api",
    serviceVersion: "0.0.1",
    environment: "local",
    logLevel: "info",
    logPretty: false,
    gitSha: "deadbee",
    buildTime: "2026-05-12T10:00:00.000Z",
  },
  http: {
    host: "127.0.0.1",
    port: 0,
    bodyLimitBytes: 1_048_576,
    requestTimeoutMs: 15_000,
    keepAliveTimeoutMs: 5_000,
  },
  postgres: {
    host: "localhost",
    port: 5432,
    database: "polaris",
    user: "polaris",
    password: "polaris",
    ssl: false,
    poolMax: 10,
    connectTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
  },
  rabbitmq: {
    url: "amqp://polaris:polaris@localhost:5672",
    managementUrl: undefined,
    clientId: "ingester-api-test",
    tls: false,
    heartbeatSeconds: 30,
    connectionTimeoutMs: 10_000,
    partitions: 3,
    partitionOverrides: {},
    assignedPartitions: [],
    prefetch: 100,
    checkpointIntervalMs: 5_000,
    checkpointEvery: 500,
    streamRetentionDays: 90,
  },
  redis: {
    host: "localhost",
    port: 6379,
    db: 0,
    username: undefined,
    password: undefined,
    connectTimeoutMs: 5_000,
    keyPrefix: undefined,
  },
  authCache: {
    maxEntries: 64,
    ttlMs: 60_000,
    negativeTtlMs: 5_000,
  },
  ingest: {
    defaultDedupeWindowSec: 900,
    maxDedupeWindowSec: 86_400,
    projectDedupeWindows: {},
    redisKeyPrefix: "polaris:ingest:dedupe",
    redisOpTimeoutMs: 50,
    maxBatchEvents: 1000,
    stampClientContext: true,
    forwardedTrustDepth: 0,
  },
  rateLimit: {
    // Tests default to unlimited (perApiKeyRps=0) so existing suites
    // don't have to thread per-test budgets through. Rate-limit-specific
    // tests pass a custom value.
    perApiKeyRps: 0,
    windowSeconds: 1,
    projectOverrides: {},
    redisKeyPrefix: "polaris:ingest:rl",
    redisOpTimeoutMs: 50,
  },
};

/**
 * Tiny in-memory `ApiKeyRepository` implementation. Tests seed it with a
 * fixture row (or several) and then exercise the auth flow.
 */
export class InMemoryApiKeyRepository implements ApiKeyRepository {
  readonly #records = new Map<string, ApiKeyRecord>();
  /** Per-call counter so tests can assert the cache prevents extra hits. */
  public lookupCount = 0;
  /** When set, the next call throws — used to simulate PostgreSQL outage. */
  public throwOnNextLookup: Error | undefined;

  set(record: ApiKeyRecord): void {
    this.#records.set(record.apiKeyId, record);
  }

  async findById(apiKeyId: string): Promise<ApiKeyRecord | null> {
    this.lookupCount += 1;
    if (this.throwOnNextLookup !== undefined) {
      const err = this.throwOnNextLookup;
      this.throwOnNextLookup = undefined;
      throw err;
    }
    return this.#records.get(apiKeyId) ?? null;
  }
}

/**
 * Recording dedupe store: behaves like `InMemoryDedupeStore` but lets tests
 * pre-program responses to simulate Redis-down or known duplicate hits.
 */
export class RecordingDedupeStore implements DedupeStore {
  public readonly claims: DedupeClaimInput[] = [];
  /** When set, the next call returns this outcome instead of the default. */
  public pendingOutcomes: DedupeClaimOutcome[] = [];
  /** When `true`, every call returns `skipped` until reset. */
  public alwaysSkip = false;
  private healthy = true;

  setHealthy(value: boolean): void {
    this.healthy = value;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async claim(input: DedupeClaimInput): Promise<DedupeClaimOutcome> {
    this.claims.push(input);
    if (this.alwaysSkip) {
      return { status: "skipped", reason: "test_redis_down" };
    }
    const next = this.pendingOutcomes.shift();
    if (next !== undefined) return next;
    return { status: "claimed" };
  }
}

/**
 * Recording producer: stand-in for `PolarisProducer`. Records every
 * `publishEvent` call so tests can assert on the canonical envelope shape
 * passed to RabbitMQ. The `send` method is intentionally a stub — the
 * handler only calls `publishEvent`.
 */
export class RecordingProducer {
  public readonly publishes: Array<{
    family: string;
    event: Record<string, unknown>;
    partitionKey: string | undefined;
  }> = [];
  public throwOnPublish: Error | undefined;
  public readonly raw: unknown = null;

  async connect(): Promise<void> {
    // no-op
  }

  async disconnect(): Promise<void> {
    // no-op
  }

  async publishEvent(input: {
    family: string;
    event: Record<string, unknown>;
    partitionKey?: string;
  }): Promise<unknown> {
    if (this.throwOnPublish !== undefined) {
      const err = this.throwOnPublish;
      this.throwOnPublish = undefined;
      throw err;
    }
    this.publishes.push({
      family: input.family,
      event: input.event,
      partitionKey: input.partitionKey,
    });
    return [];
  }

  async send(): Promise<unknown> {
    throw new Error("RecordingProducer.send not used in tests");
  }
}

/**
 * Build a minimal `EventCatalog` covering `page.viewed` v1+v2 and
 * `checkout.started` v1. Bindings come from `@polaris/spec`.
 *
 * Reusing the default schema bindings against synthetic YAML entries
 * keeps tests independent of the on-disk `definitions/events/**` tree —
 * they only depend on the catalog *types* and the schema *bindings*.
 */
export function buildTestCatalog(): EventCatalog {
  // Entries the tests assert on directly: the deprecated/sunset pair that
  // drives `schema_version_sunset`, and the two active producer events.
  const explicit: CatalogEntryFile[] = [
    {
      name: "page.viewed",
      schema_version: 1,
      domain: "page",
      owner: "web-platform",
      description: "deprecated v1",
      lifecycle: "deprecated",
      sunset_at: "2026-08-10T00:00:00Z",
    },
    {
      name: "page.viewed",
      schema_version: 2,
      domain: "page",
      owner: "web-platform",
      description: "active v2",
      lifecycle: "active",
    },
    {
      name: "checkout.started",
      schema_version: 1,
      domain: "checkout",
      owner: "commerce",
      description: "active v1",
      lifecycle: "active",
    },
  ];

  // Every other binding gets a synthesised ACTIVE entry.
  //
  // `buildCatalog` enforces a strict 1:1 between bindings and YAML, which
  // means a hand-written list here has to be extended every time a new
  // event is registered — and until it is, every ingester test fails with
  // a catalog error unrelated to what it was testing. Deriving the
  // remainder keeps the original intent (tests depend on the catalog TYPES
  // and the schema BINDINGS, never on the on-disk `definitions/events/**`
  // tree) while making that whole class of breakage impossible.
  const covered = new Set(explicit.map((e) => `${e.name}@${e.schema_version}`));
  const derived: CatalogEntryFile[] = defaultSchemaBindings
    .filter((b) => !covered.has(`${b.event}@${b.schema_version}`))
    .map((b) => ({
      name: b.event,
      schema_version: b.schema_version,
      domain: b.event.split(".")[0] ?? "platform",
      owner: "platform",
      description: `synthesised test entry for ${b.event} v${b.schema_version}`,
      lifecycle: "active" as const,
    }));

  return buildCatalog([...explicit, ...derived], defaultSchemaBindings);
}

/**
 * Build a fully-formed canonical envelope for tests.
 *
 * Producers don't normally send the stamped fields (`project_id`,
 * `environment`, `ingested_at`, `source.id`), but the canonical envelope
 * accepts both shapes. Tests can omit the trusted fields to validate the
 * ingester stamps them, or supply garbage values to validate the ingester
 * overwrites them.
 */
export function buildEnvelopePayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const base = {
    event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    event: "page.viewed",
    schema_version: 2,
    project_id: "garbage-from-producer",
    environment: "garbage-from-producer",
    occurred_at: "2026-05-11T12:00:00.000Z",
    ingested_at: "2026-05-11T12:00:01.120Z",
    source: {
      type: "browser",
      id: "garbage-from-producer",
      sdk: "web",
      sdk_version: "1.0.0",
    },
    identity: {
      anonymous_id: "anon-1",
      session_id: "sess-1",
      customer_id: null,
      device_id: null,
    },
    context: {
      ip: "203.0.113.10",
      user_agent: "Mozilla/5.0 ...",
      locale: "pt-BR",
      page: null,
      campaign: null,
    },
    properties: {
      path: "/",
      search: null,
      title: "Home",
      referrer: null,
    },
  };
  return { ...base, ...overrides };
}

// Re-export the envelope schema so tests can validate the stamped envelope
// passes the canonical contract.
export { envelopeSchema };
