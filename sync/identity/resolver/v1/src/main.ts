/**
 * Polaris identity stage (sync/identity/resolver v1) binary entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads runtime config,
 * loads the per-project identity overrides from `definitions/projects/`
 * (the denylist and narrowed semantic parameters — see `overrides.ts`),
 * builds the Fastify shell + Kysely + transport consumer/producer +
 * streaming runtime via `buildSyncIdentityApp`, starts the HTTP
 * server (for `/health`, `/ready`, `/metrics`), and lets the runtime
 * drive itself in the background.
 *
 * A failure anywhere in that chain — including an invalid identity
 * override, which `createPolicyResolver` refuses eagerly — exits
 * non-zero. Deploy-time inputs fail the deploy; they must never ride
 * along to poison the feed at runtime.
 *
 * Graceful shutdown is installed by the bootstrap for `SIGTERM` and
 * `SIGINT`. The shutdown task list stops the runtime, then disconnects
 * the consumer and producer, then ends the PostgreSQL pool — see
 * `app.ts`.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */
import { createLogger } from "@polaris/observability-logger";

import { buildSyncIdentityApp } from "./app.js";
import { loadSyncIdentityConfig } from "./config.js";
import { loadProjectIdentityOverrides } from "./overrides.js";

async function main(): Promise<void> {
  const config = loadSyncIdentityConfig();
  const bootLogger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
  });
  const projectPolicies = loadProjectIdentityOverrides({
    root: config.stage.catalogRoot,
    logger: bootLogger,
  });
  const { bootstrap } = await buildSyncIdentityApp({ config, projectPolicies });
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
      "sync-identity listening",
    );
  } catch (err) {
    logger.error({ err }, "sync-identity failed to start");
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  // Pre-bootstrap failures (config, catalog overrides, app build) land
  // here, where no structured logger is guaranteed to exist yet.
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`sync-identity boot failed: ${detail}\n`);
  process.exit(1);
});
