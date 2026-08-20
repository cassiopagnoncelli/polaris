/**
 * PostgreSQL-backed `TouchpointStore` (ADR 0005).
 *
 * Follows the seam `sync/legacy/identity-resolver/v1/src/repository.ts`
 * established: the runtime decides **what** the chain should be, the
 * repository owns **how** it is persisted. Reusing that pattern rather
 * than inventing a second one is half the reason this state went to
 * PostgreSQL instead of Redis.
 *
 * ## Key decomposition
 *
 * The runtime addresses chains by the opaque
 * `<project>::<env>::<kind>:<value>` store key. The table stores those
 * four parts as columns, so this module parses the key on the way in.
 * The alternative — storing the composite string as a single primary key
 * — would have made the table unqueryable by identifier, which is
 * precisely the operator capability the move to PostgreSQL was for.
 *
 * ## Write shape
 *
 * `set` is an upsert whose UPDATE branch deliberately never names the
 * `first_*` columns. First-touch attribution is anchored to the first
 * observation by definition; a rewrite would silently re-attribute a
 * conversion. There is no database constraint enforcing that — it would
 * take a trigger — so the enforcement is this query, which is why the
 * column list is written out rather than spread.
 *
 * @see db/postgres/migrations/20260811000001_create_attribution_touchpoint_chains.sql
 */

import type { Database } from "@polaris/persistence-postgres";
import type { Kysely } from "kysely";
import type { TouchpointStore } from "./store.js";
import type { CampaignTuple, PrimaryIdentifierKind } from "./transform.js";
import { PROCESSOR_VERSION } from "./transform.js";

/**
 * The four parts of a store key. Exported so tests can assert the
 * round-trip without reaching into the repository.
 */
export interface TouchpointStoreKeyParts {
  readonly project_id: string;
  readonly environment: string;
  readonly primary_identifier_kind: PrimaryIdentifierKind;
  readonly primary_identifier_value: string;
}

/**
 * Split `<project>::<env>::<kind>:<value>` back into its parts.
 *
 * Deliberately strict about the leading segments and deliberately loose
 * about the trailing one: an identifier value may legitimately contain a
 * colon (a URL, a namespaced customer id), so only the FIRST colon after
 * the environment separates kind from value.
 */
export function parseTouchpointStoreKey(store_key: string): TouchpointStoreKeyParts | undefined {
  const segments = store_key.split("::");
  if (segments.length !== 3) return undefined;
  const [project_id, environment, tail] = segments;
  if (project_id === undefined || environment === undefined || tail === undefined) return undefined;
  if (project_id.length === 0 || environment.length === 0) return undefined;

  // v1/v2 encoded the tail as `<kind>:<value>` because three identifier
  // kinds shared the space and `customer_id:X` had to differ from
  // `anonymous_id:X`. v3 keys on the person, so the tail IS the profile
  // id and the kind is a constant — parsing a prefix that is no longer
  // written would reject every key this version produces.
  if (tail.length === 0) return undefined;
  return {
    project_id,
    environment,
    primary_identifier_kind: "profile_id" satisfies PrimaryIdentifierKind,
    primary_identifier_value: tail,
  };
}

export interface CreateKyselyTouchpointStoreOptions {
  readonly db: Kysely<Database>;
}

/**
 * Build the production `TouchpointStore`.
 *
 * Failures propagate. Like the sessionizer's Redis store and unlike the
 * ingester's dedupe store, there is no safe degraded mode: without the
 * prior chain the engine cannot tell a first observation from a
 * continuation, and guessing would emit a `first_touch_assigned` for an
 * identifier that already had one. A database outage therefore stalls
 * the processor — the checkpoint does not advance, the message is
 * redelivered — rather than corrupting attribution.
 */
export function createKyselyTouchpointStore(
  options: CreateKyselyTouchpointStoreOptions,
): TouchpointStore {
  const { db } = options;

  return {
    async get(store_key) {
      const parts = parseTouchpointStoreKey(store_key);
      if (parts === undefined) return undefined;

      const row = await db
        .selectFrom("attribution_touchpoint_chains")
        .selectAll()
        .where("processor_version", "=", PROCESSOR_VERSION)
        .where("project_id", "=", parts.project_id)
        .where("environment", "=", parts.environment)
        .where("primary_identifier_kind", "=", parts.primary_identifier_kind)
        .where("primary_identifier_value", "=", parts.primary_identifier_value)
        .executeTakeFirst();
      if (row === undefined) return undefined;

      return {
        project_id: row.project_id,
        environment: row.environment,
        primary_identifier_kind: row.primary_identifier_kind as PrimaryIdentifierKind,
        primary_identifier_value: row.primary_identifier_value,
        first_touchpoint_id: row.first_touchpoint_id,
        first_touchpoint_tuple: row.first_touchpoint_tuple as unknown as CampaignTuple,
        first_source_event_id: row.first_source_event_id,
        first_observed_at: toIso(row.first_observed_at),
        last_touchpoint_id: row.last_touchpoint_id,
        last_touchpoint_tuple: row.last_touchpoint_tuple as unknown as CampaignTuple,
        last_source_event_id: row.last_source_event_id,
        last_observed_at: toIso(row.last_observed_at),
        // BIGINT arrives as a string from node-postgres; the chain depth
        // is small enough that Number is lossless here.
        touchpoint_count: Number(row.touchpoint_count),
      };
    },

    async set(store_key, record) {
      const parts = parseTouchpointStoreKey(store_key);
      if (parts === undefined) {
        throw new Error(
          `attribution repository: store key "${store_key}" is not <project>::<env>::<kind>:<value>`,
        );
      }

      await db
        .insertInto("attribution_touchpoint_chains")
        .values({
          processor_version: PROCESSOR_VERSION,
          project_id: parts.project_id,
          environment: parts.environment,
          primary_identifier_kind: parts.primary_identifier_kind,
          primary_identifier_value: parts.primary_identifier_value,
          first_touchpoint_id: record.first_touchpoint_id,
          first_touchpoint_tuple: toJson(record.first_touchpoint_tuple),
          first_source_event_id: record.first_source_event_id,
          first_observed_at: record.first_observed_at,
          last_touchpoint_id: record.last_touchpoint_id,
          last_touchpoint_tuple: toJson(record.last_touchpoint_tuple),
          last_source_event_id: record.last_source_event_id,
          last_observed_at: record.last_observed_at,
          touchpoint_count: record.touchpoint_count,
        })
        .onConflict((oc) =>
          oc
            .columns([
              "processor_version",
              "project_id",
              "environment",
              "primary_identifier_kind",
              "primary_identifier_value",
            ])
            // No first_* column appears here, and that omission is the
            // whole enforcement of first-touch immutability.
            .doUpdateSet({
              last_touchpoint_id: record.last_touchpoint_id,
              last_touchpoint_tuple: toJson(record.last_touchpoint_tuple),
              last_source_event_id: record.last_source_event_id,
              last_observed_at: record.last_observed_at,
              touchpoint_count: record.touchpoint_count,
              updated_at: new Date(),
            }),
        )
        .execute();
    },

    async startChain(store_key, record) {
      // Every column, first_* included. This is the reset path: the prior
      // chain expired, so its first touch is not this chain's first touch.
      const parts = parseTouchpointStoreKey(store_key);
      if (parts === undefined) {
        throw new Error(
          `attribution repository: store key "${store_key}" is not <project>::<env>::<kind>:<value>`,
        );
      }
      const values = {
        processor_version: PROCESSOR_VERSION,
        project_id: parts.project_id,
        environment: parts.environment,
        primary_identifier_kind: parts.primary_identifier_kind,
        primary_identifier_value: parts.primary_identifier_value,
        first_touchpoint_id: record.first_touchpoint_id,
        first_touchpoint_tuple: toJson(record.first_touchpoint_tuple),
        first_source_event_id: record.first_source_event_id,
        first_observed_at: record.first_observed_at,
        last_touchpoint_id: record.last_touchpoint_id,
        last_touchpoint_tuple: toJson(record.last_touchpoint_tuple),
        last_source_event_id: record.last_source_event_id,
        last_observed_at: record.last_observed_at,
        touchpoint_count: record.touchpoint_count,
      };
      await db
        .insertInto("attribution_touchpoint_chains")
        .values(values)
        .onConflict((oc) =>
          oc
            .columns([
              "processor_version",
              "project_id",
              "environment",
              "primary_identifier_kind",
              "primary_identifier_value",
            ])
            .doUpdateSet({
              first_touchpoint_id: record.first_touchpoint_id,
              first_touchpoint_tuple: toJson(record.first_touchpoint_tuple),
              first_source_event_id: record.first_source_event_id,
              first_observed_at: record.first_observed_at,
              last_touchpoint_id: record.last_touchpoint_id,
              last_touchpoint_tuple: toJson(record.last_touchpoint_tuple),
              last_source_event_id: record.last_source_event_id,
              last_observed_at: record.last_observed_at,
              touchpoint_count: record.touchpoint_count,
              updated_at: new Date(),
            }),
        )
        .execute();
    },

    async delete(store_key) {
      const parts = parseTouchpointStoreKey(store_key);
      if (parts === undefined) return;
      await db
        .deleteFrom("attribution_touchpoint_chains")
        .where("processor_version", "=", PROCESSOR_VERSION)
        .where("project_id", "=", parts.project_id)
        .where("environment", "=", parts.environment)
        .where("primary_identifier_kind", "=", parts.primary_identifier_kind)
        .where("primary_identifier_value", "=", parts.primary_identifier_value)
        .execute();
    },
  };
}

/** TIMESTAMPTZ round-trips as a Date; the record contract is ISO-8601 UTC. */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Campaign tuples cross the Kysely boundary as plain records. The cast is
 * the narrowest place to absorb `CampaignTuple`'s nullable fields into
 * the column's `Record<string, unknown>` shape.
 */
function toJson(tuple: CampaignTuple): Record<string, unknown> {
  return tuple as unknown as Record<string, unknown>;
}
