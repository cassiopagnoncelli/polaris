/**
 * Connection setup and lifecycle for the shared ClickHouse client.
 *
 * This module owns the only sanctioned import of `@clickhouse/client` in the
 * workspace. The wrapped `NodeClickHouseClient` is hidden from callers;
 * everything they see is through the role-aware surfaces (`projections`,
 * `ingestLog`, `replay`, `raw`).
 *
 * See `docs/architecture/07-clickhouse.md` "Access Control" for the policy
 * this code enforces.
 */

import {
  createClient,
  type ClickHouseClient as UnderlyingClickHouseClient,
} from "@clickhouse/client";
import {
  assertCredentialMatchesRole,
  type ClickHouseClientOptions,
  parseClickHouseConfig,
} from "./config.js";
import { ClickHouseConfigError, ClickHouseConnectionError } from "./errors.js";
import { createHealthChecker, type HealthChecker } from "./health.js";
import { createIngestLogReader, type IngestLogReader } from "./ingest-log.js";
import { type ClickHouseHealthProbes, createClickHouseHealthProbes } from "./probes/index.js";
import { createProjectionReaders, type ProjectionReaders } from "./projections/index.js";
import { createOperatorRaw, type OperatorRaw } from "./raw.js";
import { createReplayReader, type ReplayReader } from "./replay.js";
import type { Logger, MetricsRecorder } from "./types.js";

/**
 * Methods exposed on every profile. The service profile is exactly this; the
 * operator profile is this plus the operator-only namespaces.
 */
export interface ClickHouseServiceClient {
  readonly role: "service";
  readonly projections: ProjectionReaders;
  readonly ingestLog: IngestLogReader;
  readonly health: HealthChecker;
  /** Close the underlying connection pool. Idempotent. */
  close(): Promise<void>;
}

/**
 * Operator profile. Adds raw-table access via the `replay` namespace
 * (typed, dedupe-correct) and the `raw` escape hatch (observable, auditable).
 */
export interface ClickHouseOperatorClient {
  readonly role: "operator";
  readonly projections: ProjectionReaders;
  readonly ingestLog: IngestLogReader;
  readonly health: HealthChecker;
  readonly replay: ReplayReader;
  readonly raw: OperatorRaw;
  /**
   * Typed probes for `system.parts`, `system.materialized_views`, and
   * `system.kafka_consumers`. Operator-scoped because `system.*` reads
   * require the broader `polaris_operator` grants; the v1 dashboards/alerts
   * surface these signals through the analytics-projector's
   * proxy-via-canonical-consumer pattern (`docs/operations/dashboards.md`).
   */
  readonly probes: ClickHouseHealthProbes;
  close(): Promise<void>;
}

export type ClickHouseClient = ClickHouseServiceClient | ClickHouseOperatorClient;

/**
 * Construct input shape, friendlier than the full `ClickHouseClientOptions`.
 * Service callers can pass just `{ url, role, credential }` and accept the
 * defaults; operator callers should also pass `logger` and `metrics` so
 * escape-hatch emissions land somewhere observable.
 */
export interface CreateClickHouseClientInput {
  url: string;
  role: "service" | "operator";
  credential: { username: string; password: string };
  database?: string;
  requestTimeoutMs?: number;
  maxOpenConnections?: number;
  application?: string;
  logger?: Logger;
  metrics?: MetricsRecorder;
}

/**
 * Create a typed ClickHouse client bound to the declared role.
 *
 * Refuses construction if:
 * - the role is missing or not one of `service` / `operator`,
 * - the URL or credential is missing/invalid,
 * - the underlying `createClient` call throws.
 */
export function createClickHouseClient(
  input: CreateClickHouseClientInput & { role: "service" },
): ClickHouseServiceClient;
export function createClickHouseClient(
  input: CreateClickHouseClientInput & { role: "operator" },
): ClickHouseOperatorClient;
export function createClickHouseClient(input: CreateClickHouseClientInput): ClickHouseClient;
export function createClickHouseClient(input: CreateClickHouseClientInput): ClickHouseClient {
  const config = parseClickHouseConfig({
    url: input.url,
    role: input.role,
    credential: input.credential,
    database: input.database,
    requestTimeoutMs: input.requestTimeoutMs,
    maxOpenConnections: input.maxOpenConnections,
    application: input.application,
  });
  assertCredentialMatchesRole(config);

  const options: ClickHouseClientOptions = {
    config,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  };

  return buildClient(options);
}

/**
 * Variant for callers who have already parsed config (e.g. through the
 * `@polaris/shared-config` loader). Skips the Zod parse but still applies
 * the role assertion.
 */
export function createClickHouseClientFromConfig(
  options: ClickHouseClientOptions,
): ClickHouseClient {
  return buildClient(options);
}

function buildClient(options: ClickHouseClientOptions): ClickHouseClient {
  const { config } = options;

  // Guard. This branch should be unreachable because parseClickHouseConfig
  // narrows the type, but the role is load-bearing enough that we keep a
  // runtime check at the construction site as well.
  if (config.role !== "service" && config.role !== "operator") {
    throw new ClickHouseConfigError(
      `Unknown ClickHouse role: ${String(config.role)}. Refusing to construct a connection.`,
    );
  }

  const logger = options.logger?.child({
    package: "@polaris/shared-clickhouse",
    role: config.role,
    application: config.application,
  });

  let underlying: UnderlyingClickHouseClient;
  try {
    underlying = createClient({
      url: config.url,
      username: config.credential.username,
      password: config.credential.password,
      database: config.database ?? "polaris",
      application: config.application,
      max_open_connections: config.maxOpenConnections ?? 10,
      request_timeout: config.requestTimeoutMs ?? 30_000,
      // ClickHouse Cloud + on-prem both support these defaults. Compression
      // off by default; callers that want it pass `application` and we leave
      // request compression up to the server side.
      compression: {
        response: true,
        request: false,
      },
    });
  } catch (cause) {
    throw new ClickHouseConnectionError(
      `Failed to construct ClickHouse client for role '${config.role}'.`,
      { cause },
    );
  }

  logger?.debug(
    {
      url: maskUrl(config.url),
      database: config.database ?? "polaris",
      maxOpenConnections: config.maxOpenConnections ?? 10,
    },
    "clickhouse client constructed",
  );

  const projections = createProjectionReaders({ underlying });
  const ingestLog = createIngestLogReader({ underlying });
  const health = createHealthChecker({ underlying });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await underlying.close();
    logger?.debug({}, "clickhouse client closed");
  };

  if (config.role === "service") {
    const service: ClickHouseServiceClient = {
      role: "service",
      projections,
      ingestLog,
      health,
      close,
    };
    return service;
  }

  // Operator profile. The replay namespace generates argMax SQL; the raw
  // namespace is the audited escape hatch; the probes namespace exposes
  // typed wrappers over `system.*` views for canonical-consumer
  // dashboard/alert proxying.
  const replay = createReplayReader({ underlying });
  const raw = createOperatorRaw({
    underlying,
    ...(logger ? { logger } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
  });
  const probes = createClickHouseHealthProbes({ underlying });

  const operator: ClickHouseOperatorClient = {
    role: "operator",
    projections,
    ingestLog,
    health,
    replay,
    raw,
    probes,
    close,
  };
  return operator;
}

/**
 * Strip credentials from a URL for logging. The official client constructor
 * does not log the URL, but our debug line does, so we make sure we do not
 * accidentally print embedded credentials (e.g. `http://user:pass@host`).
 */
function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

// Re-exports so callers can write `client.role`-based narrowing without
// reaching into per-module files.
export type {
  ClickHouseClientConfig,
  ClickHouseClientOptions,
} from "./config.js";
