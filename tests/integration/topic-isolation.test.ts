/**
 * Isolating a project moves its traffic to a dedicated stream, and the
 * consumer still receives it.
 *
 * The acceptance criterion for 0068R, and the thing no unit test can show:
 * the producer's family resolution and the consumer's subscription set are
 * derived independently, and for months they disagreed — the consumer at
 * least ACCEPTED an isolated-projects list while the producer resolved
 * everything through `sharedOnlyIsolationLookup`. Both now read one
 * snapshot; this proves an event actually lands where that says it will.
 *
 * SKIPS unless `POLARIS_INTEGRATION=1`, matching the other files here.
 */

import type { RabbitmqConfig } from "@polaris/shared-config";
import { closeDb, createDb, type Database } from "@polaris/shared-db";
import {
  consumerFamiliesFor,
  createAmqpStreamRangeDriver,
  createPolarisProducer,
  createTransportConnection,
  declareSuperStream,
  dedicatedStreamFamily,
  readStreamRange,
  STREAM_FAMILY_RAW_EVENTS,
  startIsolationSnapshot,
  type TransportConnection,
} from "@polaris/shared-transport";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";

/** Unique per run so reruns and parallel runs cannot collide. */
const RUN = `iso${String(Date.now())}`;
const PROJECT = `${RUN}-project`;
const ENVIRONMENT = "development";

/**
 * One partition, matching the dedicated stream declared below.
 * `partitionsForFamily` gives a dedicated family its parent's width unless
 * it carries its own override, so the shared and dedicated streams stay
 * ordering-compatible — here both are 1 because this run declares its own
 * stream and never publishes to the shared one.
 */
const RABBITMQ: RabbitmqConfig = {
  url: process.env["POLARIS_RABBITMQ_URL"] ?? "amqp://polaris:polaris@localhost:5672",
  partitions: 1,
  partitionOverrides: {},
  assignedPartitions: [],
  prefetch: 10,
  checkpointIntervalMs: 5_000,
  checkpointEvery: 100,
  streamRetentionDays: 1,
} as unknown as RabbitmqConfig;

describe.skipIf(!ENABLED)("topic isolation, end to end", () => {
  let db: Kysely<Database>;
  let connection: TransportConnection;

  beforeAll(async () => {
    db = createDb({
      postgres: {
        host: process.env["POLARIS_POSTGRES_HOST"] ?? "localhost",
        port: Number(process.env["POLARIS_POSTGRES_PORT"] ?? "5432"),
        database: process.env["POLARIS_POSTGRES_DATABASE"] ?? "polaris",
        user: process.env["POLARIS_POSTGRES_USER"] ?? "polaris",
        password: process.env["POLARIS_POSTGRES_PASSWORD"] ?? "polaris",
      },
    } as unknown as Parameters<typeof createDb>[0]);

    // `topic_isolations.project_id` is a real foreign key, so the project
    // has to exist. Seeding one here rather than reusing `storefront` keeps
    // the run self-contained and its cleanup unambiguous.
    await db
      .insertInto("projects")
      .values({
        project_id: PROJECT,
        display_name: PROJECT,
        owner: "integration-test",
        description: "topic isolation integration test",
      } as never)
      .execute();

    connection = createTransportConnection({ rabbitmq: RABBITMQ });
    await connection.connect();
  }, 60_000);

  afterAll(async () => {
    await db
      .deleteFrom("topic_isolations")
      .where("project_id", "=", PROJECT)
      .execute()
      .catch(() => undefined);
    await db
      .deleteFrom("projects")
      .where("project_id", "=", PROJECT)
      .execute()
      .catch(() => undefined);
    await connection?.close().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }, 30_000);

  it("routes an isolated project's publish onto its dedicated stream", async () => {
    // The dedicated stream is provisioned explicitly, BEFORE the row exists.
    // That ordering is the cutover runbook's, and it is why a stale snapshot
    // is safe in the dangerous direction: the stream a producer is about to
    // start using is already there and already consumable.
    const dedicated = dedicatedStreamFamily(STREAM_FAMILY_RAW_EVENTS, PROJECT);
    const channel = await connection.createChannel();
    await declareSuperStream(channel, {
      family: dedicated,
      partitions: 1,
      retentionDays: 1,
      maxLengthBytes: 10 * 1024 * 1024,
    });

    // Before the row: the snapshot says shared, and the consumer would
    // subscribe to the shared family alone.
    const before = await startIsolationSnapshot({
      db,
      environment: ENVIRONMENT,
      autoStart: false,
    });
    expect(before.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, PROJECT)).toBe(false);
    expect(
      consumerFamiliesFor(
        STREAM_FAMILY_RAW_EVENTS,
        before.isolatedProjects(STREAM_FAMILY_RAW_EVENTS),
      ),
    ).not.toContain(dedicated);

    await db
      .insertInto("topic_isolations")
      .values({
        id: `polaris_tiso_${RUN}`,
        project_id: PROJECT,
        environment: ENVIRONMENT,
        topic_family: STREAM_FAMILY_RAW_EVENTS,
        concrete_topic: dedicated,
        reason: "integration test",
        actor_id: "integration-test",
      } as never)
      .execute();

    // After the row: BOTH sides change, from the same read.
    const after = await startIsolationSnapshot({
      db,
      environment: ENVIRONMENT,
      autoStart: false,
    });
    expect(after.lookup.isIsolated(STREAM_FAMILY_RAW_EVENTS, PROJECT)).toBe(true);

    const families = consumerFamiliesFor(
      STREAM_FAMILY_RAW_EVENTS,
      after.isolatedProjects(STREAM_FAMILY_RAW_EVENTS),
    );
    // The union, not a switch. An event published a moment before the row
    // landed is still on the shared stream and must still be read.
    expect(families).toContain(STREAM_FAMILY_RAW_EVENTS);
    expect(families).toContain(dedicated);

    // And the publish actually goes there.
    const producer = createPolarisProducer({ connection, producerName: RUN });
    await producer.connect();
    const eventId = `${RUN}-event`;
    await producer.publishEvent({
      family: STREAM_FAMILY_RAW_EVENTS,
      isolation: after.lookup,
      event: {
        event_id: eventId,
        event: "checkout.started",
        schema_version: 1,
        project_id: PROJECT,
        environment: ENVIRONMENT,
        occurred_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        identity: { anonymous_id: `${RUN}-anon` },
        properties: {},
      },
    });

    const now = Date.now();
    const landed = await readStreamRange(createAmqpStreamRangeDriver(connection), {
      stream: `${dedicated}-0`,
      fromTimestampMs: now - 10 * 60_000,
      toTimestampMs: now + 60_000,
      idleTimeoutMs: 2000,
    });

    // The assertion the whole card is for: the producer resolved the
    // dedicated family from the same snapshot the consumer would subscribe
    // with, and the event is on that stream rather than the shared one.
    expect(landed.events.map((e) => e.event_id)).toContain(eventId);
    await producer.disconnect();
  }, 90_000);
});
