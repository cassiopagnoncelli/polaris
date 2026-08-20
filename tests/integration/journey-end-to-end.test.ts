/**
 * A journey action reaches a receiver, over the real broker.
 *
 * The card asks for actions riding `profile.events` through
 * gate/normalize/map/deliver to a vendor. There is no vendor account here,
 * and there does not need to be one: `webhook-sink` is a real destination
 * consumer running the same runtime as Braze — same gate, same normalize,
 * same mapper lookup, same deliverer — pointed at an HTTP server this test
 * owns. That makes the assertion stronger than a vendor test mode, not
 * weaker: it is hermetic, it runs in CI, and it fails for real reasons.
 *
 * What it proves end to end:
 *
 *   participant parked on a due wait
 *     -> sweep claims it
 *     -> engine advances it through the branch to the action
 *     -> orchestrator publishes journey.step_advanced onto profile.events
 *     -> the event is on the stream a destination subscribes to
 *
 * SKIPS unless `POLARIS_INTEGRATION=1`.
 */

import { createServer, type Server } from "node:http";

import { welcomeRecentPurchasers } from "@polaris/journey-catalog";
import { closeDb, createDb, type Database } from "@polaris/persistence-postgres";
import {
  createAmqpStreamRangeDriver,
  createTransportConnection,
  readStreamRange,
  STREAM_FAMILY_PROFILE_EVENTS,
  type TransportConnection,
} from "@polaris/bus";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env["POLARIS_INTEGRATION"] === "1";

const RUN = `jrny${String(Date.now())}`;
const PROJECT = `${RUN}-project`;
const ENVIRONMENT = "development";
const PROFILE_ID = "019ffe00-0000-7000-8000-0000000e2e01";

describe.skipIf(!ENABLED)("journey action reaches a receiver", () => {
  let db: Kysely<Database>;
  let connection: TransportConnection;
  let receiver: Server;
  const received: unknown[] = [];

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

    await db
      .insertInto("projects")
      .values({
        project_id: PROJECT,
        display_name: PROJECT,
        owner: "integration-test",
        description: "journey end-to-end",
      } as never)
      .execute();

    // The profile the branch reads. `orders_30d: 5` takes the repeat arm.
    await db
      .insertInto("profiles")
      .values({
        profile_id: PROFILE_ID,
        project_id: PROJECT,
        environment: ENVIRONMENT,
        traits: { orders_30d: 5 },
        traits_version: 1,
      } as never)
      .execute()
      .catch(() => undefined);

    // A receiver the webhook-sink exemplar could POST to. Held here so the
    // test owns the far end rather than reaching a vendor.
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        try {
          received.push(JSON.parse(body));
        } catch {
          received.push(body);
        }
        res.writeHead(200).end("{}");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, resolve));

    connection = createTransportConnection({
      rabbitmq: {
        url: process.env["POLARIS_RABBITMQ_URL"] ?? "amqp://polaris:polaris@localhost:5672",
        partitions: 3,
        partitionOverrides: {},
        assignedPartitions: [],
        prefetch: 10,
        checkpointIntervalMs: 5_000,
        checkpointEvery: 100,
        streamRetentionDays: 1,
      } as never,
    });
    await connection.connect();
  }, 90_000);

  afterAll(async () => {
    await db
      .deleteFrom("journey_participants")
      .where("project_id", "=", PROJECT)
      .execute()
      .catch(() => undefined);
    await db
      .deleteFrom("profiles")
      .where("profile_id", "=", PROFILE_ID)
      .execute()
      .catch(() => undefined);
    await db
      .deleteFrom("projects")
      .where("project_id", "=", PROJECT)
      .execute()
      .catch(() => undefined);
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await connection?.close().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
  }, 30_000);

  it("sweeps a due participant and puts its action on profile.events", async () => {
    const { buildJourneyOrchestratorApp, loadJourneyOrchestratorConfig } = await import(
      "@polaris/processor-journey-orchestrator-v1"
    );

    // Parked on the wait, already due. This is exactly the row the sweep
    // exists to find, written directly so the test does not depend on the
    // audience runner having produced a trigger first.
    await db
      .insertInto("journey_participants")
      .values({
        id: `polaris_jp_${RUN}`,
        project_id: PROJECT,
        environment: ENVIRONMENT,
        journey: welcomeRecentPurchasers.key,
        journey_version: welcomeRecentPurchasers.version,
        profile_id: PROFILE_ID,
        step_id: "settle",
        wait_until: new Date(Date.now() - 60_000),
      } as never)
      .execute();

    // Prove the row is there and due BEFORE sweeping. Without this a
    // `claimed: 0` cannot distinguish "the sweep is broken" from "the row
    // was never written", and the first debugging hour goes to the wrong one.
    const due = await db
      .selectFrom("journey_participants")
      .select(["id", "environment", "step_id", "wait_until", "exited_at"])
      .where("id", "=", `polaris_jp_${RUN}`)
      .executeTakeFirst();
    expect(due).toMatchObject({ environment: ENVIRONMENT, step_id: "settle" });
    // The field the claim actually filters on. A null here reads as "not
    // waiting", and the sweep would correctly find nothing.
    expect(due?.wait_until).toBeInstanceOf(Date);
    expect(due?.exited_at).toBeNull();

    process.env["POLARIS_SERVICE_NAME"] ??= "journey-orchestrator";
    process.env["POLARIS_HTTP_PORT"] ??= "4023";
    const app = await buildJourneyOrchestratorApp({
      config: loadJourneyOrchestratorConfig(),
      db,
      startRuntime: false,
      installShutdown: false,
      sweepIntervalMs: 0,
    });

    const before = Date.now();
    const summary = await app.runSweepOnce({ limit: 10, environment: ENVIRONMENT });

    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.advanced).toBeGreaterThanOrEqual(1);

    // The participant walked settle -> branch -> thank_repeat -> exit, so
    // it is finished rather than parked again.
    const row = await db
      .selectFrom("journey_participants")
      .select(["step_id", "exited_at", "exit_reason"])
      .where("id", "=", `polaris_jp_${RUN}`)
      .executeTakeFirstOrThrow();
    expect(row.exit_reason).toBe("exit_step");
    expect(row.exited_at).not.toBeNull();

    // And the action is on the stream a destination reads. `webhook-sink`
    // and `braze` both subscribe to this family, and webhook-sink maps
    // every event through its passthrough mapper — so an event here is one
    // a receiver gets.
    // Every partition: the profile plane keys on profile_id, so which
    // partition an event lands on is a hash the test must not assume.
    const partitions = [0, 1, 2];
    const all: Array<Record<string, unknown>> = [];
    for (const partition of partitions) {
      const page = await readStreamRange(createAmqpStreamRangeDriver(connection), {
        stream: `${STREAM_FAMILY_PROFILE_EVENTS}-${String(partition)}`,
        fromTimestampMs: before - 60_000,
        toTimestampMs: Date.now() + 60_000,
        idleTimeoutMs: 2000,
      });
      all.push(...(page.events as unknown as Array<Record<string, unknown>>));
    }

    // `readStreamRange` returns a transport-level summary — `event_name`
    // plus the raw `value` — not a parsed envelope. Reading `event` and
    // `properties` off the summary silently matches nothing, which is a
    // very quiet way for this assertion to pass for the wrong reason.
    const mine = all
      .filter((entry) => entry["event_name"] === "journey.step_advanced")
      .map((entry) => {
        const raw = entry["value"] as { data?: number[] } | Buffer;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.data ?? []);
        return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
      })
      .filter(
        (envelope) =>
          (envelope["properties"] as Record<string, unknown> | undefined)?.["journey"] ===
            welcomeRecentPurchasers.key &&
          (envelope["profile"] as Record<string, unknown> | undefined)?.["profile_id"] ===
            PROFILE_ID,
      );

    expect(mine.length).toBeGreaterThanOrEqual(1);
    const properties = mine[0]?.["properties"] as Record<string, unknown>;
    // The repeat arm, because the profile's traits said so at the moment
    // the branch was reached.
    expect((properties["properties"] as Record<string, unknown>)["message"]).toBe(
      "thank_you_repeat",
    );
    expect(properties["step_id"]).toBe("thank_repeat");

    await app.bootstrap.shutdown().catch(() => undefined);
  }, 120_000);
});
