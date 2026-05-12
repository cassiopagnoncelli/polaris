/**
 * Polaris analytics-projector v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads the runtime
 * config, builds the Fastify shell + KafkaJS consumer/producer wired
 * through the `buildAnalyticsProjectorApp` factory, starts the HTTP
 * server (for `/health`, `/ready`, `/metrics`), and lets the streaming
 * runtime drive itself in the background.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, then disconnects
 * the consumer and producer in order — see `app.ts`.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */

import { buildAnalyticsProjectorApp } from "./app.js";
import { loadAnalyticsProjectorConfig } from "./config.js";

async function main(): Promise<void> {
  // Fail fast on misconfiguration — `loadAnalyticsProjectorConfig`
  // throws a typed `ConfigValidationError` that names every
  // missing/invalid env var so deployments fail loudly.
  const config = loadAnalyticsProjectorConfig();
  const { bootstrap } = await buildAnalyticsProjectorApp({ config });
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
      "analytics-projector listening",
    );
  } catch (err) {
    logger.error({ err }, "analytics-projector failed to start");
    // Allow signal handlers to drain anything that opened before the
    // listen failure, then exit non-zero so orchestrators record the
    // boot failure.
    process.exit(1);
  }
}

void main();
