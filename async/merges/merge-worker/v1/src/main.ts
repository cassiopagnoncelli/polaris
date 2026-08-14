/**
 * merge-worker v1 entrypoint.
 *
 * Config, app, listen. Everything that can fail here fails before the
 * process reports ready, which is what makes a bad deployment visible at
 * rollout rather than at the first merge.
 */

import { buildMergeWorkerApp } from "./app.js";
import { loadMergeWorkerConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadMergeWorkerConfig();
  const { bootstrap } = await buildMergeWorkerApp({ config });
  const { app, logger } = bootstrap;

  const address = await app.listen({ host: config.http.host, port: config.http.port });
  logger.info(
    {
      address,
      service: config.service.serviceName,
      version: config.service.serviceVersion,
      env: config.service.environment,
    },
    "merge-worker listening",
  );
}

void main().catch((err: unknown) => {
  // No logger yet if config loading is what failed, so this is the one place
  // a bare console write is the honest choice.
  // eslint-disable-next-line no-console
  console.error("merge-worker failed to start", err);
  process.exitCode = 1;
});
