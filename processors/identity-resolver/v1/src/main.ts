/**
 * Polaris identity-resolver v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads runtime config,
 * builds the Fastify shell + Kysely + KafkaJS consumer/producer +
 * streaming runtime via `buildIdentityResolverApp`, starts the HTTP
 * server (for `/health`, `/ready`, `/metrics`), and lets the runtime
 * drive itself in the background.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, then disconnects
 * the consumer and producer, then ends the PostgreSQL pool — see
 * `app.ts`.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */
import { buildIdentityResolverApp } from "./app.js";
import { loadIdentityResolverConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadIdentityResolverConfig();
  const { bootstrap } = await buildIdentityResolverApp({ config });
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
      "identity-resolver listening",
    );
  } catch (err) {
    logger.error({ err }, "identity-resolver failed to start");
    process.exit(1);
  }
}

void main();
