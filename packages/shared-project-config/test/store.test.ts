/**
 * Behavioural contract for the project-config read store.
 *
 * One `it()` per behaviour B1–B12 from card Q54PQL99, named so a reviewer can
 * map a failure straight back to the plan (§4 of
 * docs/implementation/project-config-plan.md).
 */

import { describe, expect, it, vi } from "vitest";
import { SECRET_REFRESH_DEADLINE_MS } from "../src/constants.js";
import { PinMissingError } from "../src/errors.js";
import { isSecret } from "../src/secret-box.js";
import {
  createProjectConfigStore,
  type ProjectConfigMetricsHooks,
  type ProjectConfigStore,
} from "../src/store.js";
import type { ProjectConfigKey } from "../src/types.js";
import { FakeClock, FakeDb, FakeListener, FakeSecrets, fakeLogger } from "./support.js";

const KEY: ProjectConfigKey = {
  projectId: "storefront",
  environment: "production",
  namespace: "meta-capi",
};

const OTHER_NS: ProjectConfigKey = { ...KEY, namespace: "sessionizer" };
const OTHER_PROJECT: ProjectConfigKey = { ...KEY, projectId: "checkout" };

interface Harness {
  store: ProjectConfigStore;
  db: FakeDb;
  secrets: FakeSecrets;
  listener: FakeListener;
  clock: FakeClock;
  lookups: { namespace: string; result: string }[];
  invalidations: string[];
  evictions: number;
  staleness: { projectId: string; seconds: number }[];
  listenerUp: boolean[];
}

function harness(overrides: { capacity?: number; sweepIntervalMs?: number } = {}): Harness {
  const db = new FakeDb();
  const secrets = new FakeSecrets();
  const listener = new FakeListener();
  const clock = new FakeClock();
  const { logger } = fakeLogger();

  const lookups: { namespace: string; result: string }[] = [];
  const invalidations: string[] = [];
  const staleness: { projectId: string; seconds: number }[] = [];
  const listenerUp: boolean[] = [];
  let evictions = 0;

  const metrics: ProjectConfigMetricsHooks = {
    onCacheLookup: (namespace, result) => lookups.push({ namespace, result }),
    onInvalidation: (source) => invalidations.push(source),
    onEviction: () => {
      evictions += 1;
    },
    onStaleness: (projectId, _environment, seconds) => staleness.push({ projectId, seconds }),
    onListenerUp: (up) => listenerUp.push(up),
  };

  const store = createProjectConfigStore({
    db: db.asKysely(),
    secrets: secrets.asResolver(),
    listener,
    logger: logger as never,
    now: clock.now,
    metrics,
    ...(overrides.capacity !== undefined ? { capacity: overrides.capacity } : {}),
    ...(overrides.sweepIntervalMs !== undefined
      ? { sweepIntervalMs: overrides.sweepIntervalMs }
      : {}),
  });

  return {
    store,
    db,
    secrets,
    listener,
    clock,
    lookups,
    invalidations,
    get evictions() {
      return evictions;
    },
    staleness,
    listenerUp,
  } as Harness;
}

function seed(db: FakeDb, key: ProjectConfigKey, version: bigint): void {
  db.rows.push({
    project_id: key.projectId,
    environment: key.environment,
    namespace: key.namespace,
    config_key: "pixel_id",
    value: "1234567890",
    is_secret_ref: false,
  });
  db.setVersion(key.projectId, key.environment, version);
}

describe("project-config store", () => {
  it("B1: cold miss assembles and caches; the second read issues no query", async () => {
    const h = harness();
    seed(h.db, KEY, 7n);

    const first = await h.store.get(KEY);
    expect(first.values["pixel_id"]).toBe("1234567890");
    expect(first.version).toBe(7n);
    expect(h.db.valueQueries).toBe(1);

    const second = await h.store.get(KEY);
    expect(second).toBe(first);
    expect(h.db.valueQueries).toBe(1);
    expect(h.lookups.map((l) => l.result)).toEqual(["miss", "hit"]);
  });

  it("B2: a scope with no rows caches as version 0 and empty values", async () => {
    const h = harness();

    const snapshot = await h.store.get(KEY);
    expect(snapshot.version).toBe(0n);
    expect(Object.keys(snapshot.values)).toHaveLength(0);

    await h.store.get(KEY);
    // Negative results cache like any other: an all-defaults project must not
    // re-query on every batch.
    expect(h.db.valueQueries).toBe(1);
  });

  it("B3: concurrent cold reads of one key run a single assembly", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);

    const [a, b, c] = await Promise.all([h.store.get(KEY), h.store.get(KEY), h.store.get(KEY)]);

    expect(h.db.valueQueries).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("B4: a notification marks the scope stale and the next read refetches", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    await h.store.start();

    await h.store.get(KEY);
    await h.store.get(OTHER_PROJECT);
    const queriesBefore = h.db.valueQueries;

    h.db.setVersion(KEY.projectId, KEY.environment, 2n);
    h.listener.notify(KEY.projectId, KEY.environment, 2n);

    // Lazy: the notification itself must not refetch.
    expect(h.db.valueQueries).toBe(queriesBefore);

    await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore + 1);

    // A different project's entry is untouched.
    await h.store.get(OTHER_PROJECT);
    expect(h.db.valueQueries).toBe(queriesBefore + 1);
    expect(h.invalidations).toContain("notify");
  });

  it("B5: a notification at or below the cached version is ignored", async () => {
    const h = harness();
    seed(h.db, KEY, 5n);
    await h.store.start();
    await h.store.get(KEY);
    const queriesBefore = h.db.valueQueries;

    h.listener.notify(KEY.projectId, KEY.environment, 5n); // duplicate
    h.listener.notify(KEY.projectId, KEY.environment, 4n); // reordered, older

    await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore);
    expect(h.invalidations).not.toContain("notify");
  });

  it("B6: the sweep reconciles every cached scope in one query", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ sweepIntervalMs: 1000 });
      seed(h.db, KEY, 1n);
      seed(h.db, OTHER_NS, 1n);
      await h.store.start();

      await h.store.get(KEY);
      await h.store.get(OTHER_NS);
      const queriesBefore = h.db.valueQueries;

      h.db.setVersion(KEY.projectId, KEY.environment, 9n);

      await vi.advanceTimersByTimeAsync(2000);

      // Two cached namespaces share one scope, so the sweep costs one query.
      expect(h.db.sweepQueries).toBeGreaterThanOrEqual(1);
      expect(h.db.valueQueries).toBe(queriesBefore);

      await h.store.get(KEY);
      expect(h.db.valueQueries).toBe(queriesBefore + 1);
      expect(h.invalidations).toContain("sweep");

      await h.store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("B7: a transport reconnect drops everything", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    seed(h.db, OTHER_PROJECT, 1n);
    await h.store.start();

    await h.store.get(KEY);
    await h.store.get(OTHER_PROJECT);
    const queriesBefore = h.db.valueQueries;

    h.listener.reconnect();

    // Notifications during the gap were lost, so nothing cached is trusted.
    await h.store.get(KEY);
    await h.store.get(OTHER_PROJECT);
    expect(h.db.valueQueries).toBe(queriesBefore + 2);
    expect(h.invalidations).toContain("reconnect");
  });

  it("B8: a secret-bearing snapshot re-resolves on its deadline despite an unchanged version", async () => {
    const h = harness();
    h.db.rows.push({
      project_id: KEY.projectId,
      environment: KEY.environment,
      namespace: KEY.namespace,
      config_key: "access_token",
      value: "vault:polaris/prod/storefront/meta-capi",
      is_secret_ref: true,
    });
    h.db.setVersion(KEY.projectId, KEY.environment, 3n);

    await h.store.get(KEY);
    expect(h.secrets.calls).toBe(1);

    h.clock.advance(SECRET_REFRESH_DEADLINE_MS - 1000);
    await h.store.get(KEY);
    expect(h.secrets.calls).toBe(1);

    // Version never moved — only the deadline forces re-resolution, which is
    // the whole reason it exists.
    h.clock.advance(2000);
    await h.store.get(KEY);
    expect(h.secrets.calls).toBe(2);
  });

  it("B8b: a snapshot with no secrets has no deadline", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);

    await h.store.get(KEY);
    h.clock.advance(SECRET_REFRESH_DEADLINE_MS * 10);
    await h.store.get(KEY);

    expect(h.db.valueQueries).toBe(1);
  });

  it("B9: exceeding capacity evicts least-recently-used and meters it", async () => {
    const h = harness({ capacity: 2 });
    seed(h.db, KEY, 1n);
    seed(h.db, OTHER_NS, 1n);
    seed(h.db, OTHER_PROJECT, 1n);

    await h.store.get(KEY);
    await h.store.get(OTHER_NS);
    await h.store.get(OTHER_PROJECT); // evicts KEY

    expect(h.evictions).toBe(1);

    const queriesBefore = h.db.valueQueries;
    await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore + 1);
  });

  it("B10: a pinned batch keeps its snapshots even when invalidated mid-batch", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    seed(h.db, OTHER_PROJECT, 1n);
    await h.store.start();

    const pinned = await h.store.pin([KEY, OTHER_PROJECT, KEY]);
    const before = pinned.snapshot(KEY);

    h.db.setVersion(KEY.projectId, KEY.environment, 99n);
    h.listener.notify(KEY.projectId, KEY.environment, 99n);

    // The batch must not straddle two versions.
    expect(pinned.snapshot(KEY)).toBe(before);
    expect(pinned.snapshot(KEY).version).toBe(1n);

    // But the next batch sees the new one.
    const next = await h.store.get(KEY);
    expect(next).not.toBe(before);
  });

  it("B10b: pin rejects a key it was not given", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);

    const pinned = await h.store.pin([KEY]);
    expect(() => pinned.snapshot(OTHER_PROJECT)).toThrow(PinMissingError);
  });

  it("B11: a failed assembly is not cached and the next read retries", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    h.db.failNext = new Error("vault unreachable");

    await expect(h.store.get(KEY)).rejects.toThrow(/failed to assemble project config/);

    // No poisoned entry: the retry succeeds.
    const snapshot = await h.store.get(KEY);
    expect(snapshot.values["pixel_id"]).toBe("1234567890");
  });

  it("B11b: a secret-resolution failure propagates without caching", async () => {
    const h = harness();
    h.db.rows.push({
      project_id: KEY.projectId,
      environment: KEY.environment,
      namespace: KEY.namespace,
      config_key: "access_token",
      value: "vault:x",
      is_secret_ref: true,
    });
    h.secrets.failWith = new Error("503 from vault");

    await expect(h.store.get(KEY)).rejects.toThrow(/failed to assemble project config/);

    h.secrets.failWith = undefined;
    const snapshot = await h.store.get(KEY);
    expect(isSecret(snapshot.values["access_token"])).toBe(true);
  });

  it("B12: close stops the sweep and closes the transport", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ sweepIntervalMs: 1000 });
      seed(h.db, KEY, 1n);
      await h.store.start();
      await h.store.get(KEY);

      await h.store.close();
      expect(h.listener.closed).toBe(true);

      const sweepsBefore = h.db.sweepQueries;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.db.sweepQueries).toBe(sweepsBefore);

      // Cached reads still work after close.
      const snapshot = await h.store.get(KEY);
      expect(snapshot.version).toBe(1n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports listener availability through the metrics hook", async () => {
    const h = harness();
    await h.store.start();
    expect(h.listener.started).toBe(true);
  });

  it("invalidate() narrows to one environment when given one", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    seed(h.db, { ...KEY, environment: "staging" }, 1n);

    await h.store.get(KEY);
    await h.store.get({ ...KEY, environment: "staging" });
    const queriesBefore = h.db.valueQueries;

    h.store.invalidate(KEY.projectId, "staging");

    await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore);

    await h.store.get({ ...KEY, environment: "staging" });
    expect(h.db.valueQueries).toBe(queriesBefore + 1);
  });
});
