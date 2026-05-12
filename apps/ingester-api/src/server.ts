/**
 * Polaris ingester binary entry point.
 *
 * Runs at container start (`node dist/server.js`). Loads the runtime config,
 * builds the Fastify instance via the shared bootstrap, and starts listening
 * on the configured host/port. Graceful shutdown is installed by the
 * bootstrap for `SIGTERM` and `SIGINT`.
 *
 * @see docs/architecture/04-ingestion-and-sdks.md "Ingester Purpose"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */

import { buildIngesterApp } from "./app.js";
import { loadIngesterConfig } from "./config.js";

async function main(): Promise<void> {
  // Fail fast on misconfiguration — loadIngesterConfig throws a typed
  // ConfigValidationError that includes every missing/invalid key.
  const config = loadIngesterConfig();

  const { app, logger } = await buildIngesterApp({ config });

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
      "ingester listening",
    );
  } catch (err) {
    logger.error({ err }, "ingester failed to start");
    // Allow signal handlers to drain anything that opened before the listen
    // failure, then exit non-zero so orchestrators record the boot failure.
    process.exit(1);
  }
}

void main();
