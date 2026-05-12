import type { FastifyInstance } from "fastify";

/**
 * Prometheus text format MIME type. The text format is the canonical
 * exposition format Prometheus scrapes; OpenMetrics adds extra metadata
 * but is wire-compatible.
 */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8" as const;

/**
 * Producer of Prometheus-formatted metric text.
 *
 * Concrete implementations (e.g. `prom-client` with `register.metrics()`)
 * will be plugged in by the P10 metrics standardisation work. The shape is
 * defined here so the route stub stays stable: services can install a
 * collector now and swap implementations later without changing the route.
 */
export type MetricsProducer = () => string | Promise<string>;

/**
 * Options for the metrics endpoint plugin.
 */
export interface MetricsPluginOptions {
  /**
   * Metrics route path. Defaults to `/metrics`.
   */
  readonly path?: string;
  /**
   * Producer that returns the Prometheus exposition payload. When omitted,
   * the route returns an empty body — useful during early bootstrap of a
   * service that has not yet wired its registry. P10 (Metrics
   * Standardisation) plugs in the real collector.
   */
  readonly producer?: MetricsProducer;
}

/**
 * Register a `/metrics` route on a Fastify instance.
 *
 * The route returns a Prometheus text payload via the supplied
 * `producer`. When no producer is configured, the route still answers 200
 * with an empty body so scrape configuration can be staged before the
 * service has metrics to emit.
 *
 * Hidden from OpenAPI generation; metrics are a platform contract scraped
 * by Prometheus, not part of the public API surface.
 */
export function registerMetricsRoute(
  app: FastifyInstance,
  options: MetricsPluginOptions = {},
): void {
  const path = options.path ?? "/metrics";
  const producer = options.producer;

  app.get(path, async (_request, reply) => {
    const body = producer !== undefined ? await producer() : "";
    return reply.code(200).header("content-type", PROMETHEUS_CONTENT_TYPE).send(body);
  });
}
