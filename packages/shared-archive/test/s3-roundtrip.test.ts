/**
 * The S3 adapter, against a real S3 API.
 *
 * Every other test in this package runs against the in-memory store,
 * which is exactly the right substrate for the durability arithmetic and
 * exactly the wrong one for the questions this file asks: does
 * `ListObjectsV2` paginate the way the adapter assumes, does a delimiter
 * listing return `CommonPrefixes` in the shape `coveredDates` parses, and
 * does a GET of a missing key raise something `isNotFound` recognises?
 * A hand-written fake answers all three however its author guessed.
 *
 * Skipped unless MinIO is reachable, so a checkout without docker still
 * runs a green suite:
 *
 *   docker compose up -d minio minio-bucket
 *
 * `POLARIS_ARCHIVE_TEST_ENDPOINT` overrides the endpoint; unset, it uses
 * the compose default of 9002 — not MinIO's usual 9000, which ClickHouse's
 * native port already owns in this compose file.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  ArchiveBatcher,
  createArchiveReplaySource,
  createArchiveWriter,
  createS3ArchiveStore,
} from "../src/index.js";

const ENDPOINT = process.env["POLARIS_ARCHIVE_TEST_ENDPOINT"] ?? "http://127.0.0.1:9002";
const BUCKET = process.env["POLARIS_ARCHIVE_TEST_BUCKET"] ?? "polaris-archive";

function makeStore(prefix: string) {
  const client = new S3Client({
    region: "us-east-1",
    endpoint: ENDPOINT,
    // MinIO addresses buckets by path, not by subdomain.
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env["MINIO_ROOT_USER"] ?? "polaris",
      secretAccessKey: process.env["MINIO_ROOT_PASSWORD"] ?? "polaris-local-dev",
    },
  });
  const store = createS3ArchiveStore({
    client,
    bucket: BUCKET,
    commands: { PutObjectCommand, GetObjectCommand, ListObjectsV2Command },
  });
  return { store, prefix };
}

/**
 * Probe with the operation the tests actually need.
 *
 * The first version of this asked MinIO's `/minio/health/live`, which
 * answers 400 — so `available` was false, every test returned early, and
 * the suite reported three passes having touched nothing. A probe that
 * checks something OTHER than what the tests need is a probe that can lie
 * in exactly this direction.
 */
async function minioReachable(): Promise<boolean> {
  try {
    await makeStore("probe").store.list("probe/");
    return true;
  } catch {
    return false;
  }
}

const available = await minioReachable();
if (!available) {
  console.warn(
    `MinIO not reachable at ${ENDPOINT} — skipping the S3 round trip. ` +
      "Start it with: docker compose up -d minio minio-bucket",
  );
}

// Reported as SKIPPED rather than passed. A suite that returns early from
// each test body is indistinguishable from one that verified something.
describe.skipIf(!available)("S3 adapter against MinIO", () => {
  // A distinct prefix per run so repeated runs do not read each other's
  // objects. Derived from the process id rather than a random number,
  // which keeps a failed run's objects findable in the bucket.
  const prefix = `test-${String(process.pid)}`;

  it("round-trips an archived window through a real bucket", async () => {
    const { store } = makeStore(prefix);
    const batcher = new ArchiveBatcher({ maxBytes: 1_000_000, maxRecords: 2, maxAgeMs: 60_000 });
    const writer = createArchiveWriter({
      store,
      batcher,
      prefix,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    const events = [
      { id: "a", at: "2026-08-15T09:00:00.000Z", offset: "1" },
      { id: "b", at: "2026-08-15T09:01:00.000Z", offset: "2" },
      { id: "c", at: "2026-08-16T21:00:00.000Z", offset: "3" },
    ];
    for (const event of events) {
      batcher.add(
        {
          projectId: "storefront",
          environment: "production",
          date: event.at.slice(0, 10),
          stream: "raw.events-0",
          offset: event.offset,
          line: JSON.stringify({
            event_id: event.id,
            event: "purchase",
            project_id: "storefront",
            environment: "production",
            occurred_at: event.at,
          }),
        },
        0,
      );
    }
    const flushed = await writer.flush(0, true);
    expect(flushed.objectsWritten).toBe(2);
    expect(batcher.durableOffset("raw.events-0")).toBe("3");

    const source = createArchiveReplaySource({ store, prefix });

    // Coverage: a delimiter listing, parsed back into dates.
    expect(
      await source.coveredDates({ projectId: "storefront", environment: "production" }),
    ).toEqual(["2026-08-15", "2026-08-16"]);

    // A window inside one day, served via that day's manifest.
    const morning = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-15T23:59:59.999Z" },
      plan: {
        project_id: "storefront",
        environment: "production",
        event_name: null,
        event_id: null,
      },
    });
    expect(morning.map((event) => event.event_id)).toEqual(["a", "b"]);

    // A window crossing the day boundary.
    const both = await source.fetchChunk({
      chunk: { from: "2026-08-15T00:00:00.000Z", to: "2026-08-16T23:59:59.999Z" },
      plan: {
        project_id: "storefront",
        environment: "production",
        event_name: null,
        event_id: null,
      },
    });
    expect(both.map((event) => event.event_id)).toEqual(["a", "b", "c"]);
  });

  it("reads a missing object as null rather than throwing", async () => {
    const { store } = makeStore(prefix);
    // The manifest is optional, and a reader that threw on its absence
    // would make an archive written before manifests existed unreadable.
    expect(
      await store.get(`${prefix}/v1/nobody/production/2026-01-01/_manifest/x.ndjson`),
    ).toBeNull();
  });

  it("paginates a listing past the 1000-key page size", async () => {
    // ListObjectsV2 returns at most 1000 keys per page. The adapter
    // follows NextContinuationToken; an adapter that did not would
    // silently return a truncated archive, and a replay would come up
    // short with no error.
    const { store } = makeStore(`${prefix}-page`);
    const day = `${prefix}-page/v1/storefront/production/2026-08-15/raw.events-0/`;
    // Written in bounded batches, not 1050 at once. The first version
    // fired every PUT concurrently and flaked under the full suite's load
    // — which is also unlike the archiver, whose writer puts one batch at
    // a time.
    const CONCURRENCY = 25;
    for (let start = 0; start < 1_050; start += CONCURRENCY) {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, 1_050 - start) }, (_unused, offset) => {
          const padded = String(start + offset).padStart(20, "0");
          return store.put({ key: `${day}${padded}-${padded}.ndjson`, body: "{}\n" });
        }),
      );
    }

    const listed = await store.list(day);
    expect(listed).toHaveLength(1_050);
    // And in key order, which the padding makes offset order.
    expect(listed[0]?.key.endsWith(`${"0".repeat(20)}-${"0".repeat(20)}.ndjson`)).toBe(true);
  }, 60_000);
});
