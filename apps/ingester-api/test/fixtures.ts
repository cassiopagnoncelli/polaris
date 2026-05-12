/**
 * Shared test fixtures.
 *
 * Tests import these to avoid duplicating the slightly fiddly
 * `IngesterConfig` and repository scaffolding across every spec.
 */

import type { IngesterConfig } from "../src/config.js";
import type { ApiKeyRecord, ApiKeyRepository } from "../src/auth/repository.js";

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
  authCache: {
    maxEntries: 64,
    ttlMs: 60_000,
    negativeTtlMs: 5_000,
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
