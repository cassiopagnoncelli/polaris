/**
 * The transport driver against a real RabbitMQ.
 *
 * Unit tests cover the driver against hand-written fakes, and those fakes
 * model a broker as "delivers exactly what the test tells it to". Several
 * of the properties Polaris depends on are not expressible that way:
 * prefetch pushing messages ahead of the handler, a quorum queue's TTL
 * actually expiring, a stream attaching at a timestamp, an unroutable
 * publish coming back as a return.
 *
 * Each assertion here was checked by mutation — the fix it guards was
 * reverted and the test confirmed to fail. The one that matters most is
 * "discards deliveries the broker pushed before a rewind": it cannot be
 * reproduced with fakes at all, and it is timing-sensitive enough that an
 * earlier version of it passed against a deliberately broken build.
 *
 * What this file deliberately does NOT cover: properties that need
 * controlled interleaving, such as matching a `basic.return` to the right
 * concurrent publish. Live timing will not reproduce those on demand;
 * they belong in the unit suite, which can hold confirms open and release
 * them out of order.
 *
 * The suite is hermetic: it declares its own test-scoped topology, uses
 * its own checkpoint groups, and deletes what it created. It never touches
 * canonical streams, so it is safe to run against a shared dev broker.
 *
 * SKIPS unless `POLARIS_INTEGRATION=1`, matching `tests/smoke/`: the
 * default `pnpm test` on every PR stays hermetic and Docker-free; the
 * integration workflow flips the var on after `docker compose up`.
 *
 * @see libs/bus/src/consumer.ts
 * @see docs/architecture/03-rabbitmq-streams.md "Failure handling"
 */

import type { RabbitmqConfig } from "@polaris/runtime-config";
import { closeDb, createDb, type Database } from "@polaris/persistence-postgres";
import type { Logger } from "@polaris/observability-logger";
import {
  buildEventHeaders,
  createAmqpStreamRangeDriver,
  createPolarisConsumer,
  createPolarisProducer,
  createTransportConnection,
  DeferredCheckpointStore,
  declareComponentQueues,
  declareSuperStream,
  dlqQueueName,
  InMemoryCheckpointStore,
  type PolarisProducer,
  PostgresCheckpointStore,
  readStreamRange,
  redeliverQueueName,
  republishToRetry,
  retryQueueName,
  type TransportConnection,
} from "@polaris/bus";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";

/** Unique per run so parallel runs and reruns cannot collide. */
const RUN = `itest${String(Date.now())}`;
/** Test-scoped family and component; never a canonical name. */
const FAMILY = `${RUN}.events`;
const COMPONENT = `${RUN}-consumer`;
const PARTITIONS = 2;

const RABBITMQ: RabbitmqConfig = {
  url: process.env["POLARIS_RABBITMQ_URL"] ?? "amqp://polaris:polaris@localhost:5672",
  managementUrl: undefined,
  clientId: "polaris-integration",
  tls: false,
  heartbeatSeconds: 30,
  connectionTimeoutMs: 10_000,
  partitions: PARTITIONS,
  partitionOverrides: {},
  assignedPartitions: [],
  prefetch: 50,
  checkpointIntervalMs: 50,
  checkpointEvery: 1,
  streamRetentionDays: 1,
};

/** The suite asserts on behaviour, not on logs. */
const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => SILENT,
} as unknown as Logger;

/**
 * Publish a canonical event onto the test family.
 *
 * `publishEvent` is not usable here: it resolves through the isolation
 * lookup, which by design only accepts the canonical `STREAM_FAMILY_*`
 * names. A hermetic harness must not write to those. `publish` takes an
 * already-resolved family and does the same partition hashing, so the
 * routing behaviour under test is identical; the headers are built with
 * the same helper `publishEvent` uses, so the wire shape is too.
 */
async function publishEvent(
  producerHandle: PolarisProducer,
  id: string,
  customer: string,
): Promise<{ stream: string; partition: number }> {
  const occurredAt = new Date().toISOString();
  return producerHandle.publish({
    family: FAMILY,
    value: Buffer.from(JSON.stringify({ event_id: id, event: "page_viewed" })),
    partitionKey: `project-alpha:production:${customer}`,
    headers: buildEventHeaders({
      event_id: id,
      event_name: "page_viewed",
      schema_version: 1,
      project_id: "project-alpha",
      environment: "production",
      occurred_at: occurredAt,
      ingested_at: occurredAt,
      producer: RUN,
      topic_family: FAMILY,
    }),
  });
}

/** Give the broker and the delivery chain time to settle. */
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!ENABLED)("transport driver against a live RabbitMQ", () => {
  let connection: TransportConnection;
  let producer: PolarisProducer;
  /** An exchange with no bindings — the only way to get a basic.return. */
  let unboundExchange: string;

  beforeAll(async () => {
    connection = createTransportConnection({ rabbitmq: RABBITMQ, logger: SILENT });
    await connection.connect();

    const channel = await connection.createChannel();
    await declareSuperStream(channel, {
      family: FAMILY,
      partitions: PARTITIONS,
      retentionDays: 1,
      maxLengthBytes: 64 * 1024 * 1024,
    });
    await declareComponentQueues(channel, COMPONENT);
    unboundExchange = `${RUN}.unbound`;
    await channel.assertExchange(unboundExchange, "direct", { durable: false });
    await channel.close();

    producer = createPolarisProducer({ connection, producerName: RUN, logger: SILENT });
    await producer.connect();
  }, 30_000);

  afterAll(async () => {
    try {
      const channel = await connection.createChannel();
      for (let p = 0; p < PARTITIONS; p += 1) {
        await channel.deleteQueue(`${FAMILY}-${String(p)}`).catch(() => undefined);
      }
      await channel.deleteExchange(FAMILY).catch(() => undefined);
      await channel.deleteExchange(unboundExchange).catch(() => undefined);
      await channel.deleteQueue(redeliverQueueName(COMPONENT)).catch(() => undefined);
      await channel.deleteQueue(dlqQueueName(COMPONENT)).catch(() => undefined);
      await channel.deleteQueue(retryQueueName(COMPONENT, 5000)).catch(() => undefined);
      await channel.deleteExchange(`${COMPONENT}.retry.dlx`).catch(() => undefined);
      await channel.close();
    } catch {
      // Cleanup is best-effort; a leftover test object is inert.
    }
    await producer.disconnect().catch(() => undefined);
    await connection.close();
  }, 30_000);

  it("declares a topology idempotently", async () => {
    // Re-declaring with identical arguments must not fail — provisioning
    // runs on every boot and every CI job.
    const channel = await connection.createChannel();
    await declareSuperStream(channel, {
      family: FAMILY,
      partitions: PARTITIONS,
      retentionDays: 1,
      maxLengthBytes: 64 * 1024 * 1024,
    });
    await declareComponentQueues(channel, COMPONENT);
    await channel.close();
  });

  it("routes one identity to one partition, and round-trips the event", async () => {
    const first = await publishEvent(producer, `${RUN}-a1`, "cust-stable");
    const second = await publishEvent(producer, `${RUN}-a2`, "cust-stable");
    expect(second.partition).toBe(first.partition);

    const checkpoints = new InMemoryCheckpointStore();
    const group = `${RUN}-roundtrip`;
    const consumer = createPolarisConsumer({
      connection,
      groupName: group,
      checkpoints,
      startPosition: "first",
      logger: SILENT,
    });
    await consumer.subscribe({ families: [FAMILY] });
    const seen: string[] = [];
    await consumer.runEach(async (_payload, ctx) => {
      if (ctx.event_id?.startsWith(RUN)) seen.push(ctx.event_id);
    });
    await settle(2000);
    await consumer.disconnect();

    expect(seen).toContain(`${RUN}-a1`);
    expect(seen).toContain(`${RUN}-a2`);

    // Resuming the same group must not re-deliver handled messages.
    const resumed = createPolarisConsumer({
      connection,
      groupName: group,
      checkpoints,
      startPosition: "first",
      logger: SILENT,
    });
    await resumed.subscribe({ families: [FAMILY] });
    const again: string[] = [];
    await resumed.runEach(async (_payload, ctx) => {
      if (ctx.event_id?.startsWith(RUN)) again.push(ctx.event_id);
    });
    await settle(1500);
    await resumed.disconnect();
    expect(again).toEqual([]);
  }, 30_000);

  it("fails an unroutable publish instead of reporting it delivered", async () => {
    // End-to-end proof that `mandatory` + the return listener turn a
    // dropped message into a failed publish against a real broker — the
    // failure mode of an incomplete topology.
    //
    // NOTE: this does NOT cover the correlation defect (a shared "last
    // return" slot blaming the wrong publish). Live timing will not
    // reliably interleave a return against a concurrent confirm; verified
    // by mutation, this test passes on the broken build. The deterministic
    // version lives in libs/bus/test/producer.test.ts,
    // which holds the confirms open and releases them out of order.
    const good = publishEvent(producer, `${RUN}-good`, "cust-good");
    const bad = producer.publish({
      family: unboundExchange,
      value: Buffer.from(JSON.stringify({ event_id: `${RUN}-bad` })),
      partitionKey: "unroutable",
      headers: { "polaris-event-id": `${RUN}-bad` },
    });

    const [goodResult, badResult] = await Promise.allSettled([good, bad]);
    expect(goodResult.status).toBe("fulfilled");
    expect(badResult.status).toBe("rejected");
    expect(String((badResult as PromiseRejectedResult).reason?.message)).toMatch(/unroutable/);
  }, 20_000);

  it("discards deliveries the broker pushed before a rewind", async () => {
    // Prefetch runs the broker ahead of the handler. The messages already
    // queued behind a failure sit at HIGHER offsets, so handling them
    // would advance the checkpoint past the failure and silently skip it.
    //
    // Reproducing it requires the whole batch to be RESIDENT before the
    // consumer attaches — publishing after the consumer starts lets each
    // message arrive on its own, and nothing is ever in flight during the
    // rewind. That timing is why the first version of this test passed
    // against a deliberately broken build.
    let key = "k-0";
    for (let i = 0; i < 100; i += 1) {
      const candidate = `flightkey-${String(i)}`;
      const probe = await producer.publish({
        family: FAMILY,
        value: Buffer.from("{}"),
        partitionKey: candidate,
        headers: { "polaris-event-id": `${RUN}-probe-${String(i)}` },
      });
      if (probe.partition === 0) {
        key = candidate;
        break;
      }
    }

    await producer.publish({
      family: FAMILY,
      value: Buffer.from("{}"),
      partitionKey: key,
      headers: { "polaris-event-id": `${RUN}-flight-bad` },
    });
    for (let i = 0; i < 5; i += 1) {
      await producer.publish({
        family: FAMILY,
        value: Buffer.from("{}"),
        partitionKey: key,
        headers: { "polaris-event-id": `${RUN}-flight-after-${String(i)}` },
      });
    }

    // Only now attach, from the start of the stream, with a prefetch wide
    // enough that the broker pushes the failure and everything behind it
    // in one go.
    const checkpoints = new InMemoryCheckpointStore();
    const consumer = createPolarisConsumer({
      connection,
      groupName: `${RUN}-inflight`,
      checkpoints,
      startPosition: "first",
      prefetch: 100,
      retryDelayMs: 200,
      maxRetryDelayMs: 400,
      maxDeliveryAttempts: 2,
      poison: { component: COMPONENT, producer },
      logger: SILENT,
    });

    const handled: string[] = [];
    let failuresSeen = 0;
    await consumer.subscribe({ families: [FAMILY], partitions: [0] });
    await consumer.runEach(async (_payload, ctx) => {
      if (!ctx.event_id?.startsWith(`${RUN}-flight`)) return;
      if (ctx.event_id === `${RUN}-flight-bad`) {
        failuresSeen += 1;
        throw new Error("cannot process");
      }
      handled.push(ctx.event_id);
    });

    await settle(8000);
    await consumer.disconnect();

    // The failure was retried the configured number of times, then
    // dead-lettered — proof the rewind actually re-read it rather than
    // sailing past on an in-flight delivery.
    expect(failuresSeen).toBe(2);
    // And every message behind it ran exactly once, in order.
    expect(handled).toEqual([
      `${RUN}-flight-after-0`,
      `${RUN}-flight-after-1`,
      `${RUN}-flight-after-2`,
      `${RUN}-flight-after-3`,
      `${RUN}-flight-after-4`,
    ]);
  }, 40_000);

  it("dead-letters a poison message and drains the partition", async () => {
    const dlqConsumer = createPolarisConsumer({
      connection,
      groupName: `${RUN}-dlqreader`,
      checkpoints: new InMemoryCheckpointStore(),
      logger: SILENT,
    });
    await dlqConsumer.subscribe({ families: [], queues: [dlqQueueName(COMPONENT)] });
    const dlq: string[] = [];
    await dlqConsumer.runEach(async (_payload, ctx) => {
      if (ctx.event_id?.startsWith(RUN)) dlq.push(ctx.event_id);
    });
    await settle(1500);
    await dlqConsumer.disconnect();

    // The poison message from the previous test must be recoverable —
    // skipping past it is only acceptable because it was preserved.
    expect(dlq).toContain(`${RUN}-flight-bad`);
  }, 20_000);

  it("holds a retry in its tier and dead-letters it into redelivery", async () => {
    // The broker owns the delay now; a fake can only assert we asked for
    // it, not that the TTL fires and the DLX routes.
    const tier = await republishToRetry(producer, {
      component: COMPONENT,
      value: Buffer.from(JSON.stringify({ event_id: `${RUN}-retry` })),
      key: "project-alpha:production:cust-0",
      headers: { "polaris-event-id": `${RUN}-retry` },
      sourceTopic: `${FAMILY}-0`,
      sourcePartition: 0,
      sourceOffset: "1",
      reason: "vendor_5xx",
      failedAt: new Date().toISOString(),
    });
    expect(tier).toBe(5000);

    const consumer = createPolarisConsumer({
      connection,
      groupName: `${RUN}-redeliver`,
      checkpoints: new InMemoryCheckpointStore(),
      logger: SILENT,
    });
    await consumer.subscribe({ families: [], queues: [redeliverQueueName(COMPONENT)] });
    const redelivered: string[] = [];
    await consumer.runEach(async (_payload, ctx) => {
      if (ctx.event_id === `${RUN}-retry`) redelivered.push(ctx.event_id);
    });
    await settle(9000);
    await consumer.disconnect();

    expect(redelivered).toEqual([`${RUN}-retry`]);
  }, 30_000);

  it("reads a time window through the replay range reader", async () => {
    const published = await publishEvent(producer, `${RUN}-replay`, "cust-replay");
    const now = Date.now();
    const result = await readStreamRange(createAmqpStreamRangeDriver(connection), {
      stream: published.stream,
      fromTimestampMs: now - 10 * 60_000,
      toTimestampMs: now,
      idleTimeoutMs: 1500,
    });

    const mine = result.events.filter((e) => e.event_id === `${RUN}-replay`);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.project_id).toBe("project-alpha");
    // Replay writes no checkpoint, so it cannot disturb a live consumer.
    expect(result.lastOffset).toBeDefined();
  }, 30_000);
});

describe.skipIf(!ENABLED)("deferred checkpoints against live PostgreSQL", () => {
  let db: Kysely<Database>;
  let durable: PostgresCheckpointStore;
  const group = `${RUN}-deferred`;

  beforeAll(() => {
    db = createDb({
      postgres: {
        host: process.env["POLARIS_POSTGRES_HOST"] ?? "localhost",
        port: Number(process.env["POLARIS_POSTGRES_PORT"] ?? "5432"),
        database: process.env["POLARIS_POSTGRES_DATABASE"] ?? "polaris",
        user: process.env["POLARIS_POSTGRES_USER"] ?? "polaris",
        password: process.env["POLARIS_POSTGRES_PASSWORD"] ?? "polaris",
        ssl: false,
        poolMax: 4,
      },
    });
    durable = new PostgresCheckpointStore(db);
  });

  afterAll(async () => {
    await db.deleteFrom("transport_checkpoints").where("group_name", "like", `${RUN}%`).execute();
    await closeDb(db);
  });

  it("keeps a held position out of the durable store until commit", async () => {
    const deferred = new DeferredCheckpointStore(durable);
    await deferred.write({ group_name: group, stream: "analytics.events-0", last_offset: "7" });
    expect(await durable.read(group, "analytics.events-0")).toBeUndefined();

    await deferred.commit(deferred.take());
    expect(await durable.read(group, "analytics.events-0")).toBe("7");
  });

  it("keeps a failed batch out of the durable store until a later commit carries it", async () => {
    const deferred = new DeferredCheckpointStore(durable);
    await deferred.write({ group_name: group, stream: "analytics.events-0", last_offset: "9" });
    const held = deferred.take();
    // The batch failed: its snapshot was never committed, so the durable
    // position is unchanged and the rows will be re-read on resume.
    expect(await durable.read(group, "analytics.events-0")).toBe("7");
    // restore() re-holds the positions for the next batch's snapshot.
    deferred.restore(held);
    expect(deferred.take()).toEqual(held);
  });

  it("reads through to the durable position, not the held one", async () => {
    // A resume must attach at what actually survived a crash.
    const deferred = new DeferredCheckpointStore(durable);
    await deferred.write({ group_name: group, stream: "analytics.events-0", last_offset: "99" });
    expect(await deferred.read(group, "analytics.events-0")).toBe("7");
  });
});
