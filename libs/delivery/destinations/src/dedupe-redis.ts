/**
 * Redis-backed destination dedupe.
 *
 * The in-memory window is per-process, so two replicas of the same consumer
 * each kept their own and neither could see the other's. Under fan-out that
 * is a double-send to a real vendor, and the dedupe window exists to prevent
 * exactly that.
 *
 * Moving the map to Redis is necessary but not sufficient. `seen()` then
 * deliver is check-then-act: with a shared store both replicas still miss,
 * both still deliver, and the window has only made the race harder to see.
 * The fix is the CLAIM in `DestinationDedupe` — `SET NX PX`, which Redis
 * decides atomically. Exactly one caller is told to proceed.
 *
 * ## Three states, and why the middle one exists
 *
 *   absent      nobody holds this delivery key
 *   claimed     someone is delivering RIGHT NOW (short TTL)
 *   confirmed   the vendor accepted (full window TTL)
 *
 * A claim expires quickly on purpose. If a replica crashes mid-delivery its
 * claim must lapse soon enough for the retry to take over — a claim that
 * outlived its holder would turn a lost delivery into a permanent one. The
 * confirmed state carries the full window because the vendor really did take
 * the event.
 *
 * ## When Redis is unreachable
 *
 * `claim()` returns `claimed`. Fail-OPEN, deliberately, and it is the
 * uncomfortable half of the design: a Redis outage degrades to the
 * single-process behaviour that shipped before this, which can double-send.
 * Failing closed would refuse every delivery for every destination while
 * Redis was down — trading a rare duplicate for a total outage, on a path
 * where the vendors themselves dedupe on `dedupe_key` (Meta `event_id`, GA4
 * `transaction_id`) which the runtime forwards regardless.
 *
 * The same call cannot be both, so this is a choice, and the log line makes
 * it visible rather than silent.
 */

import type { Logger } from "@polaris/observability-logger";

import type { DedupeClaim, DestinationDedupe } from "./dedupe.js";

/**
 * Minimum client surface used here, declared structurally so tests pass a
 * fake and this package takes no `ioredis` dependency.
 */
export interface DestinationDedupeRedisClient {
  set(
    key: string,
    value: string,
    mode1: "PX",
    ttl: number,
    mode2: "NX",
  ): Promise<"OK" | null | string>;
  set(key: string, value: string, mode1: "PX", ttl: number): Promise<"OK" | null | string>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface RedisDestinationDedupeOptions {
  readonly client: DestinationDedupeRedisClient;
  /** Namespace, so one Redis can serve more than one Polaris deployment. */
  readonly keyPrefix?: string;
  /** Full window for a CONFIRMED delivery. Default 15 minutes. */
  readonly windowMs?: number;
  /** How long an unconfirmed claim holds the key. Default 60 seconds. */
  readonly claimTtlMs?: number;
  readonly logger?: Logger;
}

/** Sentinel stored while a delivery is in flight. */
const CLAIM_VALUE = "claimed";

export function createRedisDestinationDedupe(
  options: RedisDestinationDedupeOptions,
): DestinationDedupe {
  const prefix = options.keyPrefix ?? "polaris:dst:dedupe";
  const windowMs = options.windowMs ?? 15 * 60_000;
  const claimTtlMs = options.claimTtlMs ?? 60_000;

  const keyFor = (destinationId: string, deliveryKey: string): string =>
    `${prefix}:${destinationId}:${deliveryKey}`;

  const degrade = (op: string, err: unknown): void => {
    options.logger?.warn(
      { component: "destination.dedupe.redis", op, err },
      "destination dedupe degraded to fail-open — Redis unreachable",
    );
  };

  return {
    async claim(destination_id, delivery_key, _nowMs): Promise<DedupeClaim> {
      const key = keyFor(destination_id, delivery_key);
      try {
        const set = await options.client.set(key, CLAIM_VALUE, "PX", claimTtlMs, "NX");
        if (set === "OK") return { kind: "claimed" };

        // Someone holds it. Read the value to tell an in-flight claim from a
        // confirmed delivery — the caller logs them differently, and only one
        // of them carries a timestamp worth reporting.
        const held = await options.client.get(key);
        if (held === null) {
          // Expired between the SET and the GET. Racing again would be a
          // loop; treating it as a duplicate costs at most one skipped
          // delivery, which the retry path re-presents.
          return { kind: "duplicate" };
        }
        if (held === CLAIM_VALUE) return { kind: "duplicate" };
        const deliveredAt = Number.parseInt(held, 10);
        return Number.isFinite(deliveredAt)
          ? { kind: "duplicate", deliveredAt }
          : { kind: "duplicate" };
      } catch (err) {
        degrade("claim", err);
        return { kind: "claimed" };
      }
    },

    async mark(destination_id, delivery_key, deliveredAt): Promise<void> {
      // No NX: this overwrites the caller's own claim, which is the point —
      // the key moves from claimed to confirmed and its TTL extends to the
      // full window.
      try {
        await options.client.set(
          keyFor(destination_id, delivery_key),
          String(deliveredAt),
          "PX",
          windowMs,
        );
      } catch (err) {
        degrade("mark", err);
      }
    },

    async release(destination_id, delivery_key): Promise<void> {
      const key = keyFor(destination_id, delivery_key);
      try {
        // Only an unconfirmed claim is releasable. Deleting a confirmed entry
        // would reopen the window on a delivery that really happened, which
        // is the one thing this store must never do.
        const held = await options.client.get(key);
        if (held === CLAIM_VALUE) await options.client.del(key);
      } catch (err) {
        degrade("release", err);
      }
    },

    async seen(destination_id, delivery_key): Promise<number | undefined> {
      try {
        const held = await options.client.get(keyFor(destination_id, delivery_key));
        if (held === null || held === CLAIM_VALUE) return undefined;
        const deliveredAt = Number.parseInt(held, 10);
        return Number.isFinite(deliveredAt) ? deliveredAt : undefined;
      } catch (err) {
        degrade("seen", err);
        return undefined;
      }
    },
  };
}
