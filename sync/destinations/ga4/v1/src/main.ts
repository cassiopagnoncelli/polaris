/**
 * Polaris ga4 v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads the runtime
 * config, builds the Fastify shell + KafkaJS consumer/producer + Kysely
 * client + destination consumer runtime through `buildGa4App`, starts
 * the HTTP server (for `/health`, `/ready`, `/metrics`), and lets the
 * destination runtime drive itself in the background.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, disconnects the
 * consumer and producer, then ends the PostgreSQL pool — see `app.ts`.
 *
 * @see docs/architecture/06-destinations.md "Destination Consumer"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */

import { buildGa4App } from "./app.js";
import { loadGa4Config } from "./config.js";

async function main(): Promise<void> {
  const config = loadGa4Config();
  const { bootstrap } = await buildGa4App({ config });
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
      "ga4 listening",
    );
  } catch (err) {
    logger.error({ err }, "ga4 failed to start");
    process.exit(1);
  }
}

void main();
