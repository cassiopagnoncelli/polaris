/**
 * Polaris enrichment stage (sync/enrichment/runtime v1) entry point.
 *
 * Runs at container start (`node dist/main.js`). Loads runtime config,
 * loads the per-project enrichment overrides from `catalog/projects/`,
 * builds the service via `buildSyncEnrichmentApp`, and starts the HTTP
 * shell for `/health`, `/ready`, `/metrics` while the runtime drives
 * itself in the background.
 *
 * Any failure in that chain exits non-zero, including an out-of-bounds
 * override: deploy-time inputs fail the deploy rather than riding along
 * to poison the feed at runtime.
 *
 * @see docs/architecture/05-processors-and-replay.md "Processor Model"
 * @see docs/architecture/09-engineering-standards.md "Containers"
 */
import { createLogger } from "@polaris/shared-logger";

import { buildSyncEnrichmentApp } from "./app.js";
import { loadSyncEnrichmentConfig } from "./config.js";
import { loadProjectEnrichmentOverrides } from "./overrides.js";

async function main(): Promise<void> {
  const config = loadSyncEnrichmentConfig();
  const bootLogger = createLogger({
    service: config.service.serviceName,
    version: config.service.serviceVersion,
    env: config.service.environment,
  });
  const projectPolicies = loadProjectEnrichmentOverrides({
    root: config.stage.catalogRoot,
    logger: bootLogger,
  });
  const { bootstrap } = await buildSyncEnrichmentApp({ config, projectPolicies });
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
      "sync-enrichment listening",
    );
  } catch (err) {
    logger.error({ err }, "sync-enrichment failed to start");
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  // Pre-bootstrap failures (config, catalog overrides, app build) land
  // here, where no structured logger is guaranteed to exist yet.
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`sync-enrichment boot failed: ${detail}\n`);
  process.exit(1);
});
