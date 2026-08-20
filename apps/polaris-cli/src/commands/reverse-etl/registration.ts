/**
 * Production wiring for `polaris reverse-etl run`.
 *
 * Built PER INVOCATION, not at registration: the ClickHouse client and the
 * ingest key come from THIS run's environment and project config, and a
 * client constructed at registration would hold the first invocation's
 * credentials forever.
 *
 * ## The ingest key
 *
 * Read from project config under `reverse_etl.ingest_api_key`, an
 * `is_secret` value — set with `polaris config set --secret`, never
 * printed back, never in a crontab where `ps` would show it. Provisioning
 * is documented on `run.ts`.
 *
 * ## The read is service-role
 *
 * Jobs read PROJECTIONS, which `scripts/lint-trait-sql.mjs` enforces and
 * `scripts/check-catalog-sql.mjs` verifies against the real schema. So a
 * job cannot become a full scan over raw customer data whatever its SQL
 * says, and a nightly cron never needs operator credentials.
 */

import type { IngestBatchResult } from "@polaris/processor-reverse-etl-v1";
import type { ReverseEtlRow } from "@polaris/reverse-etl-catalog";
import { createClickHouseClient } from "@polaris/persistence-clickhouse";

import { listProjectConfig, revealProjectConfigSecret } from "@polaris/persistence-control-plane";

import type { CommandContext } from "../../command.js";
import { connectDb } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import type { ReverseEtlRunHooks } from "./run.js";

const CLICKHOUSE_URL_ENV = "POLARIS_CLICKHOUSE_URL";
const CLICKHOUSE_USER_ENV = "POLARIS_CLICKHOUSE_SERVICE_USER";
const CLICKHOUSE_PASSWORD_ENV = "POLARIS_CLICKHOUSE_SERVICE_PASSWORD";
const INGEST_URL_ENV = "POLARIS_INGEST_URL";
/** Project-config key holding the internal-source API key. `is_secret`. */
export const INGEST_KEY_NAMESPACE = "reverse_etl";
export const INGEST_KEY_NAME = "ingest_api_key";
export const INGEST_KEY_CONFIG_KEY = `${INGEST_KEY_NAMESPACE}.${INGEST_KEY_NAME}`;

export function buildRegisteredReverseEtlHooks(): ReverseEtlRunHooks {
  return {
    /**
     * The `reverse_etl` slice, for the enablement check.
     *
     * `listProjectConfig` masks secret values, which is exactly right
     * here: this slice also holds `ingest_api_key`, and the enablement
     * check has no business seeing it. The one caller that needs the
     * plaintext goes through `revealProjectConfigSecret` below, which is
     * greppable for that reason.
     */
    readProjectConfig: async (ctx, scope) => {
      const handle = connectDb({ env: ctx.env });
      try {
        const rows = await listProjectConfig(handle.db, {
          projectId: scope.projectId,
          environment: scope.environment as Parameters<typeof listProjectConfig>[1]["environment"],
          namespace: "reverse_etl",
        });
        return Object.fromEntries(rows.map((row) => [row.config_key, row.value]));
      } finally {
        await handle.close();
      }
    },

    query: (ctx: CommandContext) => {
      const url = ctx.env[CLICKHOUSE_URL_ENV];
      if (url === undefined || url.trim().length === 0) {
        throw new UsageError(
          `${CLICKHOUSE_URL_ENV} is required: jobs read ClickHouse projections.`,
        );
      }
      const client = createClickHouseClient({
        url,
        role: "service",
        credential: {
          username: ctx.env[CLICKHOUSE_USER_ENV] ?? "polaris_service",
          password: ctx.env[CLICKHOUSE_PASSWORD_ENV] ?? "",
        },
        database: "polaris",
        application: "polaris-reverse-etl",
      });
      return {
        // The same reader trait definitions use — projections only, two
        // bound parameters, no third the job could widen its scope with.
        run: (input) =>
          client.traitQuery.run(input) as unknown as Promise<readonly ReverseEtlRow[]>,
        close: () => client.close(),
      };
    },

    ingest: (ctx: CommandContext, scope) => {
      const endpoint = ctx.env[INGEST_URL_ENV]?.trim();
      if (endpoint === undefined || endpoint.length === 0) {
        throw new UsageError(
          `${INGEST_URL_ENV} is required: the runner posts events to the ingester, never to the stream.`,
        );
      }
      return {
        async send(events): Promise<IngestBatchResult> {
          const token = await readIngestKey(ctx, scope);
          if (token === null || token.length === 0) {
            throw new UsageError(
              `${INGEST_KEY_CONFIG_KEY} is not set for ${scope.projectId}/${scope.environment}. ` +
                "Issue a key for an internal source and store it with " +
                "`polaris config set --secret`; see the header of run.ts.",
            );
          }

          const response = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/events`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-polaris-api-key": token },
            body: JSON.stringify({ events }),
          });
          if (!response.ok) {
            // The whole batch failed at the transport, which is different
            // from per-event rejection: no event was evaluated, so none
            // may be reported as rejected-for-a-reason.
            throw new Error(
              `ingester answered ${String(response.status)} for a batch of ${String(events.length)}`,
            );
          }
          const body = (await response.json()) as {
            accepted?: unknown[];
            rejected?: Array<{ code?: string }>;
          };
          const rejected = body.rejected ?? [];
          return {
            accepted: (body.accepted ?? []).length,
            rejected: rejected.length,
            // Reason codes only. The rejected entries also carry detail
            // that can name a field path, and a run record is not a place
            // to accumulate those.
            rejectedReasons: [...new Set(rejected.map((entry) => entry.code ?? "unknown"))],
          };
        },
      };
    },
  };
}

/**
 * The internal-source API key, from project config.
 *
 * Read through `revealProjectConfigSecret`, the same query
 * `polaris config get --reveal` uses — so there is one way to read a
 * secret and one place auditing it, rather than a second path this
 * command invented.
 *
 * The namespace/key split follows the platform's convention:
 * `reverse_etl` is the namespace a job's settings live under, and
 * `ingest_api_key` is the value.
 */
async function readIngestKey(
  ctx: CommandContext,
  scope: { projectId: string; environment: string },
): Promise<string | null> {
  const handle = connectDb({ env: ctx.env });
  try {
    const value = await revealProjectConfigSecret(handle.db, {
      projectId: scope.projectId,
      environment: scope.environment as Parameters<
        typeof revealProjectConfigSecret
      >[1]["environment"],
      namespace: INGEST_KEY_NAMESPACE,
      configKey: INGEST_KEY_NAME,
    });
    return typeof value === "string" && value.length > 0 ? value : null;
  } finally {
    await handle.close();
  }
}
