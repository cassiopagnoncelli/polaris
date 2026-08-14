/**
 * Polaris geoip-enricher v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads the runtime
 * config, builds the Fastify shell + KafkaJS consumer/producer wired
 * through the `buildGeoipEnricherApp` factory, starts the HTTP server
 * (for `/health`, `/ready`, `/metrics`), and lets the streaming
 * runtime drive itself in the background.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, then disconnects
 * the consumer and producer in order — see `app.ts`.
 *
 * The default `IPLookup` is `NoOpIPLookup` (fail-open: emits enriched
 * events with all-null geo and `source = "no_lookup"`). A follow-up
 * task introduces a MaxMind-backed adapter wired here behind a config
 * env var.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */

import { buildGeoipEnricherApp } from "./app.js";
import { loadGeoipEnricherConfig } from "./config.js";

async function main(): Promise<void> {
  // Fail fast on misconfiguration — `loadGeoipEnricherConfig` throws a
  // typed `ConfigValidationError` that names every missing/invalid env
  // var so deployments fail loudly.
  const config = loadGeoipEnricherConfig();
  const { bootstrap } = await buildGeoipEnricherApp({ config });
  const { app, logger } = bootstrap;

  try {
    const address = await app.listen({
      host: config.http.host,
      port: config.http.port,
    });
    logger.info(
      {
        address,
        host: config.http.host,
        port: config.http.port,
        service: config.service.serviceName,
        version: config.service.serviceVersion,
        env: config.service.environment,
      },
      "geoip-enricher listening",
    );
  } catch (err) {
    logger.error({ err }, "geoip-enricher failed to start");
    // Allow signal handlers to drain anything that opened before the
    // listen failure, then exit non-zero so orchestrators record the
    // boot failure.
    process.exit(1);
  }
}

void main();
