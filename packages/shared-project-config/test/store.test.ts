/**
 * Behavioural contract for the project-config read store.
 *
 * One `it()` per behaviour B1–B12 from card Q54PQL99, named so a reviewer can
 * map a failure straight back to the plan (§4 of
 * docs/implementation/project-config-plan.md).
 */

import { describe, expect, it, vi } from "vitest";
import { PinMissingError } from "../src/errors.js";
import { isSecret, type Secret } from "../src/secret-box.js";
import {
  createProjectConfigStore,
  type ProjectConfigMetricsHooks,
  type ProjectConfigStore,
} from "../src/store.js";
import type { ProjectConfigKey } from "../src/types.js";
import { FakeClock, FakeDb, FakeListener, fakeLogger } from "./support.js";

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
    is_secret: false,
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

  it("B8: a secret row arrives boxed, with the stored value intact inside it", async () => {
    const h = harness();
    h.db.rows.push({
      project_id: KEY.projectId,
      environment: KEY.environment,
      namespace: KEY.namespace,
      config_key: "access_token",
      value: "EAAB-live-token-value",
      is_secret: true,
    });
    h.db.setVersion(KEY.projectId, KEY.environment, 3n);

    const snapshot = await h.store.get(KEY);
    const token = snapshot.values["access_token"];

    // A consumer must be able to reach the real value — a delivery needs it.
    expect(isSecret(token)).toBe(true);
    expect((token as Secret<string>).expose()).toBe("EAAB-live-token-value");

    // And nothing that stringifies the snapshot may reach it. This is the
    // whole job of the box now that the store caches plaintext rather than a
    // pointer: one `JSON.stringify` in a log line or a DLQ payload would
    // otherwise publish the credential.
    expect(JSON.stringify(snapshot)).not.toContain("EAAB-live-token-value");
    expect(String(token)).toBe("[redacted]");
  });

  it("B8b: a secret-bearing snapshot is NOT refetched on a timer", async () => {
    // Pins a deliberate removal. A wall-clock deadline used to force
    // re-resolution of secret-bearing snapshots regardless of version, because
    // rotating a credential in Vault moved no version and the fleet would
    // otherwise serve a revoked one indefinitely. A stored secret changes only
    // by a write, and a write bumps the version — so the deadline would now be
    // a periodic refetch that can never observe anything new.
    const h = harness();
    h.db.rows.push({
      project_id: KEY.projectId,
      environment: KEY.environment,
      namespace: KEY.namespace,
      config_key: "access_token",
      value: "EAAB-live-token-value",
      is_secret: true,
    });
    h.db.setVersion(KEY.projectId, KEY.environment, 3n);

    await h.store.get(KEY);
    h.clock.advance(3_000_000);
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

  it("B11b: a failed assembly of a secret-bearing scope leaves no partial entry", async () => {
    // B11 covers the same rule for ordinary values; this one exists because a
    // half-cached secret scope is the worse failure — a consumer would read a
    // snapshot whose credential key is simply absent and quietly fall back to
    // its deployment default, delivering with the wrong account rather than
    // failing.
    const h = harness();
    h.db.rows.push({
      project_id: KEY.projectId,
      environment: KEY.environment,
      namespace: KEY.namespace,
      config_key: "access_token",
      value: "EAAB-live-token-value",
      is_secret: true,
    });
    h.db.failNext = new Error("connection reset");

    await expect(h.store.get(KEY)).rejects.toThrow(/failed to assemble project config/);
    expect(h.store.peek(KEY)).toBeUndefined();

    const snapshot = await h.store.get(KEY);
    expect(isSecret(snapshot.values["access_token"])).toBe(true);
  });

  it("B13: a write committing during a cold assembly leaves the entry born stale", async () => {
    // The race: assembly reads version (old), a writer commits values+version
    // and its NOTIFY fires, then assembly reads values. The notification
    // cannot mark an entry that does not exist yet, so without the
    // mid-assembly bookkeeping the snapshot would cache as fresh and the
    // change would wait for the sweep.
    const h = harness();
    seed(h.db, KEY, 1n);
    await h.store.start();

    let release: (() => void) | undefined;
    h.db.holdNextValueQuery = new Promise((resolve) => {
      release = resolve;
    });

    const assembling = h.store.get(KEY); // version read (1n), parked before values

    h.db.setVersion(KEY.projectId, KEY.environment, 2n);
    h.listener.notify(KEY.projectId, KEY.environment, 2n);
    release?.();

    const first = await assembling;
    expect(first.version).toBe(1n); // under-labeled, by design

    // The next read must refetch rather than serve the parked snapshot.
    const queriesBefore = h.db.valueQueries;
    const second = await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore + 1);
    expect(second.version).toBe(2n);
  });

  it("B13b: a mid-assembly notification at or below the assembled version is ignored", async () => {
    const h = harness();
    seed(h.db, KEY, 5n);
    await h.store.start();

    let release: (() => void) | undefined;
    h.db.holdNextValueQuery = new Promise((resolve) => {
      release = resolve;
    });
    const assembling = h.store.get(KEY);
    h.listener.notify(KEY.projectId, KEY.environment, 4n); // older — reordered delivery
    release?.();
    await assembling;

    const queriesBefore = h.db.valueQueries;
    await h.store.get(KEY);
    expect(h.db.valueQueries).toBe(queriesBefore); // still a hit
  });

  it("B14: a versions row that vanished while cached marks the entry stale", async () => {
    // A deleted project CASCADEs its versions row away. `0 < cached` must not
    // read as "still fresh", or the fleet serves a dead project's
    // configuration forever.
    vi.useFakeTimers();
    try {
      const h = harness({ sweepIntervalMs: 1000 });
      seed(h.db, KEY, 3n);
      await h.store.start();
      await h.store.get(KEY);

      h.db.versions.clear();
      await vi.advanceTimersByTimeAsync(2000);

      const queriesBefore = h.db.valueQueries;
      const snapshot = await h.store.get(KEY);
      expect(h.db.valueQueries).toBe(queriesBefore + 1);
      expect(snapshot.version).toBe(0n);
      expect(h.invalidations).toContain("sweep");

      await h.store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("B15: peek serves a stale entry AND triggers its refresh", async () => {
    // The defect this pins: a peek-only reader (the ingester) is the only
    // observer of its entries. If peek returns the stale snapshot without
    // kicking a refresh, get() is never called again and a config change
    // never reaches the service — the cutover's whole capability, silently
    // dead.
    const h = harness();
    seed(h.db, KEY, 1n);
    await h.store.start();
    await h.store.get(KEY);

    h.db.rows[0] = { ...h.db.rows[0], value: "updated-pixel" } as (typeof h.db.rows)[0];
    h.db.setVersion(KEY.projectId, KEY.environment, 2n);
    h.listener.notify(KEY.projectId, KEY.environment, 2n);

    // Serves the old snapshot — a request path never stalls on freshness —
    // and schedules the refetch as a side effect.
    const beforeRefresh = h.store.peek(KEY);
    expect(beforeRefresh?.values["pixel_id"]).toBe("1234567890");

    // One macrotask drains every microtask the background assembly chains.
    await new Promise((resolve) => setImmediate(resolve));
    const afterRefresh = h.store.peek(KEY);
    expect(afterRefresh?.values["pixel_id"]).toBe("updated-pixel");
    expect(afterRefresh?.version).toBe(2n);
  });

  it("B15b: a burst of peeks on a stale entry schedules one refresh", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    await h.store.start();
    await h.store.get(KEY);
    const queriesBefore = h.db.valueQueries;

    h.listener.notify(KEY.projectId, KEY.environment, 2n);
    h.store.peek(KEY);
    h.store.peek(KEY);
    h.store.peek(KEY);

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.db.valueQueries).toBe(queriesBefore + 1);
  });

  it("B15c: peek neither queries nor refreshes a fresh entry", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    await h.store.get(KEY);
    const queriesBefore = h.db.valueQueries;

    expect(h.store.peek(KEY)?.version).toBe(1n);
    await Promise.resolve();
    expect(h.db.valueQueries).toBe(queriesBefore);
    expect(h.lookups.at(-1)).toEqual({ namespace: KEY.namespace, result: "peek_hit" });
  });

  it("B15d: peek on an uncached scope returns undefined without I/O", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    expect(h.store.peek(KEY)).toBeUndefined();
    expect(h.db.valueQueries).toBe(0);
    expect(h.lookups.at(-1)).toEqual({ namespace: KEY.namespace, result: "peek_miss" });
  });

  it("B16: warm resolves scopes and swallows per-scope failures", async () => {
    const h = harness();
    seed(h.db, KEY, 1n);
    seed(h.db, OTHER_PROJECT, 1n);
    h.db.failNext = new Error("first assembly fails");

    // Must not throw: a scope that will not assemble at boot stays cold and
    // its callers use defaults.
    await h.store.warm([KEY, OTHER_PROJECT]);

    // One of the two failed (failNext consumes once); the other is cached.
    const cached = [h.store.peek(KEY), h.store.peek(OTHER_PROJECT)].filter(
      (snapshot) => snapshot !== undefined,
    );
    expect(cached).toHaveLength(1);
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
