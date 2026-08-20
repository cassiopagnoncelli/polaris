/**
 * The global RPS bound.
 *
 * `max_rps` is a promise made to a vendor. The in-memory limiter kept it per
 * process, so three replicas of one consumer sent up to 3x the number an
 * operator set — and on a vendor that answers overage with 429s, that is a
 * self-inflicted retry storm.
 */

import { describe, expect, it } from "vitest";

import type { DestinationInstance } from "../src/db/destination-instance.js";
import { createRedisDestinationRateLimiter } from "../src/rate-limiter-redis.js";

function instance(overrides: Partial<DestinationInstance> = {}): DestinationInstance {
  return {
    destination_id: "polaris_dst_1",
    project_id: "storefront",
    environment: "production",
    vendor: "webhook",
    instance_label: "team-a",
    secret_value: "",
    status: "active",
    mode: "live",
    max_concurrency: 100,
    max_rps: 2,
    retry_policy: "standard",
    dead_letter_threshold: 5,
    replay_opt_in: true,
    config: {},
    ...overrides,
  };
}

/** A Redis fake shared between "replicas", which is the whole point. */
function redisFake() {
  const counters = new Map<string, number>();
  return {
    counters,
    client: {
      incr: async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      },
      pexpire: async () => 1,
    },
  };
}

describe("redis rate limiter", () => {
  it("counts across replicas, which is the entire reason it exists", async () => {
    // Three limiters, one Redis: three replicas of one consumer. With
    // max_rps=2, the third acquisition in the same second must wait rather
    // than sail through on its own private counter.
    const fake = redisFake();
    let clock = 10_000;
    const slept: number[] = [];
    const make = () =>
      createRedisDestinationRateLimiter({
        client: fake.client,
        now: () => clock,
        sleep: async (ms) => {
          slept.push(ms);
          clock += ms;
        },
      });

    const replicas = [make(), make(), make()];
    for (const replica of replicas) {
      (await replica.acquire(instance())).release();
    }

    // Two fit in the second; the third had to wait for the next boundary.
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(1000 - (10_000 % 1000));
  });

  it("lets a fresh second through without waiting", async () => {
    const fake = redisFake();
    let clock = 10_000;
    const limiter = createRedisDestinationRateLimiter({
      client: fake.client,
      now: () => clock,
      sleep: async () => {
        throw new Error("should not have waited");
      },
    });
    (await limiter.acquire(instance())).release();
    clock += 1000;
    (await limiter.acquire(instance())).release();
    expect(fake.counters.size).toBe(2);
  });

  it("scopes the budget per destination and environment", async () => {
    // Two instances of one vendor in one project must not spend each other's
    // budget — `max_rps` is per destination row.
    const fake = redisFake();
    const limiter = createRedisDestinationRateLimiter({
      client: fake.client,
      now: () => 10_000,
      sleep: async () => {
        throw new Error("should not have waited");
      },
    });
    (await limiter.acquire(instance({ destination_id: "a" }))).release();
    (await limiter.acquire(instance({ destination_id: "b" }))).release();
    (await limiter.acquire(instance({ destination_id: "a", environment: "staging" }))).release();
    expect(fake.counters.size).toBe(3);
  });

  it("falls back to the per-process bound when Redis is unreachable", async () => {
    // A Redis outage degrades to the behaviour that shipped before this
    // rather than halting delivery for every destination.
    const limiter = createRedisDestinationRateLimiter({
      client: {
        incr: async () => {
          throw new Error("ECONNREFUSED");
        },
        pexpire: async () => 1,
      },
      now: () => 10_000,
    });
    const lease = await limiter.acquire(instance());
    expect(lease.destination_id).toBe("polaris_dst_1");
    lease.release();
  });

  it("gives up waiting rather than livelocking on a misconfigured budget", async () => {
    // `max_rps: 0` can be stored. Spinning forever here would hold a
    // concurrency slot and read as a hung consumer; slow delivery is the
    // failure an operator can actually diagnose.
    const fake = redisFake();
    let clock = 10_000;
    let waits = 0;
    const limiter = createRedisDestinationRateLimiter({
      client: fake.client,
      now: () => clock,
      sleep: async (ms) => {
        waits += 1;
        clock += ms;
      },
    });
    const lease = await limiter.acquire(instance({ max_rps: 0 }));
    expect(waits).toBe(10);
    lease.release();
  });

  it("reports the total wait, concurrency plus RPS", async () => {
    // An operator asking "why is this destination slow" needs one number,
    // not one of the two reasons.
    const fake = redisFake();
    let clock = 10_000;
    const limiter = createRedisDestinationRateLimiter({
      client: fake.client,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    (await limiter.acquire(instance({ max_rps: 1 }))).release();
    const second = await limiter.acquire(instance({ max_rps: 1 }));
    expect(second.waited_ms).toBeGreaterThan(0);
    second.release();
  });
});
