/**
 * Polaris clickhouse-sink v1 binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads config, builds the
 * Fastify shell + transport consumer + ClickHouse writer through
 * `buildClickhouseSinkApp`, starts the HTTP server (for `/health`,
 * `/ready`, `/metrics`), and lets the sink runtime drive itself.
 *
 * Graceful shutdown is installed by the bootstrap for SIGTERM/SIGINT. The
 * shutdown list stops the runtime (flushing the open batch), closes the
 * transport, closes the ClickHouse client, then ends the Postgres pool —
 * see `app.ts`.
 *
 * @see docs/architecture/07-clickhouse.md
 */

import { buildClickhouseSinkApp } from "./app.js";
import { loadClickhouseSinkConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadClickhouseSinkConfig();
  const { bootstrap } = await buildClickhouseSinkApp({ config });
  const { app, logger } = bootstrap;

  try {
    const address = await app.listen({ host: config.http.host, port: config.http.port });
    logger.info(
      {
        address,
        service: config.service.serviceName,
        version: config.service.serviceVersion,
        env: config.service.environment,
      },
      "clickhouse-sink listening",
    );
  } catch (err) {
    logger.error({ err }, "clickhouse-sink failed to start");
    process.exit(1);
  }
}

await main();
