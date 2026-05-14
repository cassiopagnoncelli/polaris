/**
 * Polaris webhook-sink v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads the runtime
 * config, builds the Fastify shell + KafkaJS consumer/producer + Kysely
 * client + destination consumer runtime through `buildWebhookSinkApp`,
 * starts the HTTP server (for `/health`, `/ready`, `/metrics`), and lets
 * the destination runtime drive itself in the background.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, disconnects the
 * consumer and producer, then ends the PostgreSQL pool — see `app.ts`.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */

import { buildWebhookSinkApp } from "./app.js";
import { loadWebhookSinkConfig } from "./config.js";

async function main(): Promise<void> {
  // Fail fast on misconfiguration — `loadWebhookSinkConfig` throws a
  // typed `ConfigValidationError` that names every missing/invalid env
  // var so deployments fail loudly.
  const config = loadWebhookSinkConfig();
  const { bootstrap } = await buildWebhookSinkApp({ config });
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
      "webhook-sink listening",
    );
  } catch (err) {
    logger.error({ err }, "webhook-sink failed to start");
    // Allow signal handlers to drain anything that opened before the
    // listen failure, then exit non-zero so orchestrators record the
    // boot failure.
    process.exit(1);
  }
}

void main();
