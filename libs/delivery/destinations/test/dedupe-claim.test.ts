/**
 * The dedupe CLAIM, in memory and against a Redis fake.
 *
 * The headline is the multi-replica double-send. `seen()` then deliver was
 * check-then-act, and no amount of sharing the window closes that: both
 * replicas miss, both deliver, both mark. The first test below is the one
 * that fails against the old contract.
 */

import { describe, expect, it } from "vitest";
import { type DestinationDedupe, InMemoryDestinationDedupe } from "../src/dedupe.js";
import { createRedisDestinationDedupe } from "../src/dedupe-redis.js";

/** A Redis fake with real SET NX PX semantics and no clock. */
function redisFake() {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      set: async (key: string, value: string, _px: "PX", _ttl: number, nx?: "NX") => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK" as const;
      },
      get: async (key: string) => store.get(key) ?? null,
      del: async (key: string) => (store.delete(key) ? 1 : 0),
    },
  };
}

const CASES: ReadonlyArray<{ name: string; make: () => DestinationDedupe }> = [
  { name: "in-memory", make: () => new InMemoryDestinationDedupe() },
  {
    name: "redis",
    make: () => createRedisDestinationDedupe({ client: redisFake().client }),
  },
];

for (const { name, make } of CASES) {
  describe(`dedupe claim — ${name}`, () => {
    it("lets exactly one of two concurrent replicas through", async () => {
      // THE test. Two replicas race on the same delivery key with no
      // interleaving in between — precisely the shape that produced a double
      // send to a real vendor. Under the old `seen()` contract both would be
      // told to proceed.
      const dedupe = make();
      const [a, b] = await Promise.all([
        dedupe.claim("dst_1", "pdk_1", 1_000),
        dedupe.claim("dst_1", "pdk_1", 1_000),
      ]);
      const claimed = [a, b].filter((r) => r.kind === "claimed");
      expect(claimed).toHaveLength(1);
    });

    it("would have double-sent under the old check-then-act contract", async () => {
      // The test above can be read as passing trivially — single-threaded JS
      // serialises `Promise.all`, so nothing truly interleaves. This one
      // makes the race explicit using the `seen`/`mark` pair that shipped
      // before the claim: both replicas ask, both are told the key is fresh,
      // and only then does either mark. That is the interleaving a real
      // two-replica deployment produces, and it is what the claim removes.
      const dedupe = make();
      const replicaA = await dedupe.seen("dst_1", "pdk_1");
      const replicaB = await dedupe.seen("dst_1", "pdk_1");
      expect(replicaA).toBeUndefined();
      expect(replicaB).toBeUndefined(); // ← both would have delivered

      // Same interleaving, claim contract: the second is refused before
      // either has marked anything.
      const fresh = make();
      expect((await fresh.claim("dst_2", "pdk_2", 1_000)).kind).toBe("claimed");
      expect((await fresh.claim("dst_2", "pdk_2", 1_000)).kind).toBe("duplicate");
    });

    it("reports a confirmed delivery's timestamp to the loser", async () => {
      const dedupe = make();
      expect((await dedupe.claim("dst_1", "pdk_1", 1_000)).kind).toBe("claimed");
      await dedupe.mark("dst_1", "pdk_1", 4_242);

      const second = await dedupe.claim("dst_1", "pdk_1", 2_000);
      expect(second).toEqual({ kind: "duplicate", deliveredAt: 4_242 });
    });

    it("reports no timestamp while the holder is still in flight", async () => {
      // A claim nobody has confirmed is a different fact from a completed
      // delivery, and an operator reading the log needs to tell them apart:
      // one means "already sent", the other means "being sent right now".
      const dedupe = make();
      await dedupe.claim("dst_1", "pdk_1", 1_000);
      expect(await dedupe.claim("dst_1", "pdk_1", 1_000)).toEqual({ kind: "duplicate" });
    });

    it("frees the key when a delivery fails", async () => {
      // Without this the retry would be refused by its own predecessor —
      // a failed delivery would block the attempt meant to replace it.
      const dedupe = make();
      await dedupe.claim("dst_1", "pdk_1", 1_000);
      await dedupe.release("dst_1", "pdk_1");
      expect((await dedupe.claim("dst_1", "pdk_1", 2_000)).kind).toBe("claimed");
    });

    it("refuses to release a CONFIRMED delivery", async () => {
      // The one thing this store must never do: reopen the window on
      // something the vendor really accepted.
      const dedupe = make();
      await dedupe.claim("dst_1", "pdk_1", 1_000);
      await dedupe.mark("dst_1", "pdk_1", 4_242);
      await dedupe.release("dst_1", "pdk_1");
      expect((await dedupe.claim("dst_1", "pdk_1", 2_000)).kind).toBe("duplicate");
    });

    it("scopes the window per destination instance", async () => {
      const dedupe = make();
      await dedupe.claim("dst_1", "pdk_1", 1_000);
      expect((await dedupe.claim("dst_2", "pdk_1", 1_000)).kind).toBe("claimed");
    });
  });
}

describe("dedupe claim — redis specifics", () => {
  it("fails OPEN when Redis is unreachable", async () => {
    // The uncomfortable half of the design, stated as a test so it is a
    // decision rather than an accident. A Redis outage degrades to the
    // single-process behaviour that shipped before this — which can
    // double-send — instead of refusing every delivery for every
    // destination while Redis is down. The vendors dedupe on the
    // `dedupe_key` the runtime forwards regardless.
    const dead = {
      set: async () => {
        throw new Error("ECONNREFUSED");
      },
      get: async () => {
        throw new Error("ECONNREFUSED");
      },
      del: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const dedupe = createRedisDestinationDedupe({ client: dead });
    expect((await dedupe.claim("dst_1", "pdk_1", 1_000)).kind).toBe("claimed");
    // And the other operations do not throw into a delivery.
    await dedupe.mark("dst_1", "pdk_1", 1);
    await dedupe.release("dst_1", "pdk_1");
    expect(await dedupe.seen("dst_1", "pdk_1")).toBeUndefined();
  });

  it("namespaces keys so one Redis can serve two deployments", async () => {
    const fake = redisFake();
    const dedupe = createRedisDestinationDedupe({
      client: fake.client,
      keyPrefix: "staging:dedupe",
    });
    await dedupe.claim("dst_1", "pdk_1", 1_000);
    expect([...fake.store.keys()]).toEqual(["staging:dedupe:dst_1:pdk_1"]);
  });
});
