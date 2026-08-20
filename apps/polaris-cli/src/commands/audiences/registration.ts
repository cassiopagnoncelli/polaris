/**
 * Constructing the real audiences runner for the registered command.
 *
 * Split from `compute.ts` for the same reason the traits runner is split
 * from its command: the selection and refusal logic should be testable
 * without a ClickHouse cluster, a database, or a broker — which are
 * exactly the dependencies this file introduces.
 *
 * ## Three seams, and one that is usually absent
 *
 * The PROFILE read goes through the same narrow trait window the traits
 * runner writes through. Audiences only ever read it.
 *
 * The MEMBERSHIP write goes through `@polaris/persistence-control-plane`'s
 * audience functions — `audience_memberships` and nothing else. A batch
 * writer that cannot touch profiles or identifiers cannot cause an
 * identity split, which is the same argument that made the async trait
 * writer acceptable.
 *
 * The EMIT publishes onto `profile.events`, the family the identity stage
 * and the traits runner already write.
 *
 * The QUERY seam is built lazily and only when a `projection` audience is
 * actually selected. Most runs are trait-sourced, and opening a ClickHouse
 * connection for every nightly audience pass that never queries would be a
 * connection, a credential, and a failure mode for nothing.
 */

import { type AudienceRunResult, runAudiences } from "@polaris/processor-audiences-v1";
import { createClickHouseClient } from "@polaris/persistence-clickhouse";
import { loadConfigWithDefaults, rabbitmqEnvSchema } from "@polaris/runtime-config";
import {
  createPolarisProducer,
  createTransportConnection,
  sharedOnlyIsolationLookup,
} from "@polaris/bus";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext } from "../../command.js";
import {
  connectDb,
  enterAudience,
  exitAudience,
  findProfileById,
  findProfilesWithTraits,
  listAudienceMemberships,
  restampAudienceMemberships,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import type { AudiencesComputeRunner } from "./compute.js";
import { createAudienceEventEmitter } from "./emitter.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_SERVICE_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_SERVICE_PASSWORD";

export function buildRegisteredAudiencesRunner(ctx: CommandContext): AudiencesComputeRunner {
  const handle = connectDb({ env: ctx.env });
  const runId = `polaris_arun_${uuidv7()}`;

  // A short-lived connection per invocation, like the traits command's.
  // The process exits after one run; a pooled producer would outlive
  // nothing.
  const connection = createTransportConnection({
    rabbitmq: loadConfigWithDefaults({ serviceName: "polaris-cli", schema: rabbitmqEnvSchema }),
  });
  const producer = createPolarisProducer({
    connection,
    producerName: "polaris-cli.audiences-compute",
  });

  return {
    async run({ projectId, environment, audiences }): Promise<AudienceRunResult> {
      const needsQuery = audiences.some((definition) => definition.source === "projection");
      const clickhouse = needsQuery ? openServiceClickHouse(ctx) : undefined;

      await producer.connect();
      try {
        return await runAudiences({
          projectId,
          environment,
          audiences: [...audiences],
          runId,
          profiles: {
            profilesWithTraits: (input) => findProfilesWithTraits(handle.db, input),
          },
          memberships: {
            listMemberships: (scope) => listAudienceMemberships(handle.db, scope),
            enter: (input) => enterAudience(handle.db, input),
            exit: (input) => exitAudience(handle.db, input),
            restamp: (input) => restampAudienceMemberships(handle.db, input),
          },
          emitter: createAudienceEventEmitter({
            producer,
            // Shared streams only, for the same reason the traits emitter
            // says: a CLI invocation has no control-plane isolation cache,
            // and publishing an isolated project's transitions to the
            // shared family is worse than the hop the cache saves.
            isolation: sharedOnlyIsolationLookup,
            now: () => new Date(),
            // Without this the transition carries `profile_id` only, and
            // every destination skips it — a vendor keys on the brand's
            // customer id, not on Polaris's internal surrogate.
            identities: async ({ profileId }) => {
              const profile = await findProfileById(handle.db, profileId);
              return profile?.canonical_customer_id ?? null;
            },
          }),
          ...(clickhouse !== undefined
            ? {
                query: {
                  run: ({ sql, projectId: p, environment: e }) =>
                    clickhouse.traitQuery.run({ sql, projectId: p, environment: e }) as Promise<
                      ReadonlyArray<{ readonly profile_id: string }>
                    >,
                },
              }
            : {}),
        });
      } finally {
        await producer.disconnect().catch(() => {});
        if (clickhouse !== undefined) await clickhouse.close();
        await handle.close();
      }
    },
  };
}

/**
 * SERVICE role, not operator.
 *
 * Audience SQL is held to the projections allowlist by
 * `scripts/lint-trait-sql.mjs`, exactly as trait SQL is, so the service
 * role suffices — and a nightly cron holding operator credentials is a
 * standing invitation nobody needs to accept.
 */
function openServiceClickHouse(ctx: CommandContext) {
  const url = ctx.env[CLICKHOUSE_URL_ENV];
  if (url === undefined || url.trim().length === 0) {
    throw new UsageError(
      `${CLICKHOUSE_URL_ENV} is required: a projection-sourced audience reads ClickHouse. ` +
        "See infra/backups/crontab.example for the environment a scheduled run needs.",
    );
  }
  return createClickHouseClient({
    url,
    role: "service",
    credential: {
      username: ctx.env[CLICKHOUSE_USER_ENV] ?? "polaris_service",
      password: ctx.env[CLICKHOUSE_PASSWORD_ENV] ?? "",
    },
    database: "polaris",
    application: "polaris-audiences-compute",
  });
}
