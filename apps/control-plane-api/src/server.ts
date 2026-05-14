/**
 * Polaris control-plane API binary entry point.
 *
 * Runs at container start (`node dist/server.js`). Loads the runtime
 * config, builds the Fastify shell + auth + gate wiring through
 * `buildControlPlaneApp`, starts the HTTP server, and lets the
 * bootstrap manage graceful shutdown.
 */
import { buildControlPlaneApp } from "./app.js";
import { loadControlPlaneConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadControlPlaneConfig();
  const bootstrap = await buildControlPlaneApp({ config });
  const { app, logger } = bootstrap;

  try {
    const address = await app.listen({ host: config.http.host, port: config.http.port });
    logger.info(
      {
        address,
        host: config.http.host,
        port: config.http.port,
        service: config.service.serviceName,
        version: config.service.serviceVersion,
        env: config.service.environment,
      },
      "control-plane-api listening",
    );
  } catch (err) {
    logger.error({ err }, "control-plane-api failed to start");
    process.exit(1);
  }
}

void main();
