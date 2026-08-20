/**
 * Constructing the real traits runner for the registered command.
 *
 * Split from `compute.ts` for the same reason the rebuild driver is split
 * from its command: the selection and refusal logic should be testable
 * without a ClickHouse cluster, a database, or a broker — which are exactly
 * the dependencies this file introduces.
 *
 * ## Three seams, three prior decisions
 *
 * The QUERY goes through the ClickHouse **service** client. Trait SQL is
 * projections-only, enforced by `scripts/lint-trait-sql.mjs`, so the service
 * role suffices and the operator escape hatch stays closed to a nightly cron
 * job. A cron with operator credentials is a standing invitation.
 *
 * The WRITE goes through `@polaris/persistence-control-plane`'s narrow trait
 * window — `traits` and `traits_version`, nothing else. That is the
 * async-writer allowance the plan's amended ownership line names, and the
 * narrowness is what makes it safe: a batch writer that cannot touch
 * identifiers cannot cause an identity split.
 *
 * The EMIT publishes onto `profile.events`, the family the identity stage
 * already writes. `profile.updated`'s catalog entry says that stream IS
 * trait history; this is the writer that makes the claim true for computed
 * traits.
 */

import { runTraits, type TraitRunResult } from "@polaris/processor-traits-v1";
import { createClickHouseClient } from "@polaris/persistence-clickhouse";
import { loadConfigWithDefaults, rabbitmqEnvSchema } from "@polaris/runtime-config";
import {
  createPolarisProducer,
  createTransportConnection,
  sharedOnlyIsolationLookup,
} from "@polaris/bus";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext } from "../../command.js";
import { applyProfileTraitChange, connectDb, findProfilesWithTraits } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import type { TraitsComputeRunner } from "./compute.js";
import { createTraitEventEmitter } from "./emitter.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_SERVICE_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_SERVICE_PASSWORD";

export function buildRegisteredTraitsRunner(ctx: CommandContext): TraitsComputeRunner {
  const url = ctx.env[CLICKHOUSE_URL_ENV];
  if (url === undefined || url.trim().length === 0) {
    throw new UsageError(
      `${CLICKHOUSE_URL_ENV} is required: trait definitions read ClickHouse projections. ` +
        "See infra/backups/crontab.example for the environment a scheduled run needs.",
    );
  }

  const clickhouse = createClickHouseClient({
    url,
    // SERVICE, not operator. Trait SQL is projections-only by lint, so the
    // service role is sufficient — and a nightly cron holding operator
    // credentials is a standing invitation nobody needs to accept.
    role: "service",
    credential: {
      username: ctx.env[CLICKHOUSE_USER_ENV] ?? "polaris_service",
      password: ctx.env[CLICKHOUSE_PASSWORD_ENV] ?? "",
    },
    database: "polaris",
    application: "polaris-traits-compute",
  });
  const handle = connectDb({ env: ctx.env });
  const runId = `polaris_trun_${uuidv7()}`;

  // A short-lived connection per invocation, like the replay commands'. The
  // process exits after one run; a pooled producer would outlive nothing.
  const connection = createTransportConnection({
    rabbitmq: loadConfigWithDefaults({ serviceName: "polaris-cli", schema: rabbitmqEnvSchema }),
  });
  const producer = createPolarisProducer({
    connection,
    producerName: "polaris-cli.traits-compute",
  });

  return {
    async run({ projectId, environment, traits }): Promise<TraitRunResult> {
      await producer.connect();
      try {
        return await runTraits({
          projectId,
          environment,
          traits: [...traits],
          runId,
          now: () => Date.now(),
          query: {
            run: async ({ sql, projectId: p, environment: e }) => {
              return clickhouse.traitQuery.run({ sql, projectId: p, environment: e });
            },
          },
          store: {
            profilesWithTraits: (input) => findProfilesWithTraits(handle.db, input),
            applyTraitChange: async ({ projectId: p, environment: e, change }) => {
              const applied = await applyProfileTraitChange(handle.db, {
                projectId: p,
                environment: e,
                profileId: change.profileId,
                set: change.set,
                remove: change.remove,
              });
              // A profile retired between the diff and the write — a merge
              // or a rebuild can do that. Not an error worth failing a whole
              // run for; the next run simply will not see it.
              return {
                traitsVersion: applied?.traitsVersion ?? 0,
                canonicalCustomerId: applied?.canonicalCustomerId ?? null,
              };
            },
          },
          // Published onto `profile.events`, not logged. Logging left
          // computed traits in an operator's log file and out of the spine,
          // which meant `polaris.profiles` in ClickHouse — a table whose
          // whole premise is that stream being trait history — was fed only
          // by the identity stage.
          emitter: createTraitEventEmitter({
            producer,
            // Shared streams only. A CLI invocation has no control-plane
            // isolation cache, and publishing an isolated project's traits
            // to the shared family would be worse than the extra hop the
            // cache saves: the consumer reads both.
            isolation: sharedOnlyIsolationLookup,
            now: () => new Date(),
          }),
        });
      } finally {
        await producer.disconnect().catch(() => {});
        await clickhouse.close();
        await handle.close();
      }
    },
  };
}
