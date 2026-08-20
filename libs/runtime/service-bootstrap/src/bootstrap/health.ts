import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Outcome of a single readiness probe. Probes are async functions that
 * return `ReadinessProbeResult` and never throw — throws are caught by the
 * runner and treated as `status: "down"`.
 */
export interface ReadinessProbeResult {
  /** Logical name of the dependency (e.g. `postgres`, `redpanda`). */
  readonly name: string;
  /** Probe outcome. */
  readonly status: "up" | "down" | "degraded";
  /** Optional human-readable detail (kept short — surfaced in JSON). */
  readonly detail?: string;
  /** Optional latency in milliseconds, for trend tracking. */
  readonly latencyMs?: number;
}

/**
 * Async readiness probe contract.
 *
 * Probes are passed the active Fastify instance so they can re-use any
 * decorators / clients the service installed (`app.postgres`,
 * `app.redpanda`, ...). The caller is responsible for keeping probes fast
 * (target: < 1s) and side-effect free.
 */
export type ReadinessProbe = (app: FastifyInstance) => Promise<ReadinessProbeResult>;

/**
 * Build-time service metadata surfaced by the `/health` route.
 */
export interface ServiceInfo {
  /** Service name (`ingester-api`, `control-plane-api`, ...). */
  readonly serviceName: string;
  /** Package or release version stamped at build time. */
  readonly serviceVersion: string;
  /** Optional git SHA stamped at build time. */
  readonly gitSha?: string;
  /** Optional ISO 8601 build timestamp stamped at build time. */
  readonly buildTime?: string;
  /**
   * Optional human-readable pipeline release label (e.g. `2026-q2-r1`).
   * Distinct from `serviceVersion`: a single release label may bundle many
   * services with distinct package versions. Surfaced on `/health` as
   * `release_label` so an operator bisecting a production rollout can map
   * one tag to many running services. See `docs/deployment/versioning.md`.
   */
  readonly releaseLabel?: string;
  /** Optional deployment environment (`production`, `staging`, ...). */
  readonly environment?: string;
}

/**
 * Options for the shared health/readiness plugin.
 */
export interface HealthPluginOptions {
  /** Required service metadata exposed under `/health`. */
  readonly info: ServiceInfo;
  /**
   * Readiness probes for `/ready`. The route returns 200 only when every
   * probe reports `status: "up"`. A probe reporting `"degraded"` is
   * surfaced individually but still rolls up to a 503 by default.
   */
  readonly probes?: ReadonlyArray<ReadinessProbe>;
  /**
   * Health route path. Defaults to `/health`.
   */
  readonly healthPath?: string;
  /**
   * Readiness route path. Defaults to `/ready`.
   */
  readonly readinessPath?: string;
  /**
   * Whether a `"degraded"` probe counts as not-ready. Defaults to `true`
   * so `/ready` fails closed; flipping to `false` is useful for services
   * that want to keep serving traffic during partial outages.
   */
  readonly degradedIsNotReady?: boolean;
}

/**
 * Run all readiness probes with bounded fault tolerance. A throwing probe
 * is recorded as `"down"` with the error message in `detail`.
 */
async function runProbes(
  app: FastifyInstance,
  probes: ReadonlyArray<ReadinessProbe>,
): Promise<ReadinessProbeResult[]> {
  const settled = await Promise.allSettled(probes.map((probe) => probe(app)));
  const out: ReadinessProbeResult[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const probe = probes[i];
    if (probe === undefined) continue;
    const result = settled[i];
    if (result === undefined) continue;
    if (result.status === "fulfilled") {
      out.push(result.value);
    } else {
      const reason = result.reason;
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "probe threw a non-Error value";
      out.push({ name: extractProbeName(probe), status: "down", detail: message });
    }
  }
  return out;
}

function extractProbeName(probe: ReadinessProbe): string {
  // `probe.name` reflects the JS function name; falls back to a generic
  // label when the probe is anonymous.
  return probe.name && probe.name.length > 0 ? probe.name : "unnamed_probe";
}

/**
 * Register the shared `/health` and `/ready` routes on a Fastify instance.
 *
 * `/health` is intentionally trivial: it answers 200 as long as the process
 * is up. Use it for container liveness probes and load-balancer aliveness.
 *
 * `/ready` aggregates the supplied probes and answers 503 if any probe is
 * not `"up"` (or `"degraded"` when `degradedIsNotReady` is `true`).
 * Container readiness probes / Kubernetes readiness checks should use this.
 *
 * Routes opt out of OpenAPI generation by setting `schema.hide = true`.
 */
export function registerHealthRoutes(app: FastifyInstance, options: HealthPluginOptions): void {
  const healthPath = options.healthPath ?? "/health";
  const readinessPath = options.readinessPath ?? "/ready";
  const probes = options.probes ?? [];
  const degradedIsNotReady = options.degradedIsNotReady ?? true;

  app.get(healthPath, async (_request, _reply) => {
    return {
      status: "ok",
      service: options.info.serviceName,
      version: options.info.serviceVersion,
      git_sha: options.info.gitSha,
      build_time: options.info.buildTime,
      release_label: options.info.releaseLabel,
      environment: options.info.environment,
      time: new Date().toISOString(),
    };
  });

  app.get(readinessPath, async (_request: FastifyRequest, reply: FastifyReply) => {
    const results = await runProbes(app, probes);
    const ready = results.every((r) =>
      degradedIsNotReady ? r.status === "up" : r.status !== "down",
    );
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      service: options.info.serviceName,
      version: options.info.serviceVersion,
      time: new Date().toISOString(),
      probes: results,
    };
  });
}
