// @vitest-environment happy-dom
/**
 * `LifecycleController` — orchestrates eager-flush window, steady mode,
 * and pagehide.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   0-15s after SDK init       eager flush mode (100ms debounce)
 *   after 15s                 steady batch mode (5s interval)
 *   pagehide/manual flush      urgent flush mode
 *
 * The lifecycle controller is tiny by design: it knows about windows,
 * debounces, intervals, and DOM events. Tests use injected timer
 * functions so we don't pay vitest's real-timer cost.
 */

import { describe, expect, it, vi } from "vitest";

import { LifecycleController } from "../src/internal/lifecycle.js";

interface FakeTimers {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
  advance: (ms: number) => void;
  pendingCount: () => number;
}

function fakeTimers(): FakeTimers {
  let now = 0;
  interface Scheduled {
    runAt: number;
    fn: () => void;
    interval?: number;
    active: boolean;
  }
  const scheduled = new Map<number, Scheduled>();
  let nextId = 1;

  const setTimeoutFn = ((fn: () => void, ms: number) => {
    const id = nextId++;
    scheduled.set(id, { runAt: now + ms, fn, active: true });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    const entry = scheduled.get(id as unknown as number);
    if (entry !== undefined) entry.active = false;
  }) as unknown as typeof clearTimeout;

  const setIntervalFn = ((fn: () => void, ms: number) => {
    const id = nextId++;
    scheduled.set(id, { runAt: now + ms, fn, interval: ms, active: true });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  const clearIntervalFn = ((id: ReturnType<typeof setInterval>) => {
    const entry = scheduled.get(id as unknown as number);
    if (entry !== undefined) entry.active = false;
  }) as unknown as typeof clearInterval;

  return {
    setTimeoutFn,
    clearTimeoutFn,
    setIntervalFn,
    clearIntervalFn,
    advance: (ms: number) => {
      const target = now + ms;
      // Multiple passes to fire interval re-arms.
      while (true) {
        let next: Scheduled | undefined;
        let nextId2: number | undefined;
        for (const [id, entry] of scheduled.entries()) {
          if (!entry.active) continue;
          if (entry.runAt > target) continue;
          if (next === undefined || entry.runAt < next.runAt) {
            next = entry;
            nextId2 = id;
          }
        }
        if (next === undefined || nextId2 === undefined) {
          now = target;
          return;
        }
        now = next.runAt;
        next.active = false;
        try {
          next.fn();
        } catch {
          // Tests can assert error paths via the flushCallback instead.
        }
        if (next.interval !== undefined) {
          // Re-arm the interval.
          scheduled.set(nextId2, {
            runAt: now + next.interval,
            fn: next.fn,
            interval: next.interval,
            active: true,
          });
        }
      }
    },
    pendingCount: () => {
      let n = 0;
      for (const e of scheduled.values()) if (e.active) n += 1;
      return n;
    },
  };
}

describe("LifecycleController — eager mode", () => {
  it("debounces eager-flush triggers within the eager window", () => {
    const timers = fakeTimers();
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 15_000,
      eagerDebounceMs: 100,
      steadyIntervalMs: 5_000,
      flushOnPagehide: false,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    lc.start(flush);
    lc.notifyEnqueue();
    lc.notifyEnqueue();
    lc.notifyEnqueue();
    // No flush yet — debounce not elapsed.
    expect(flush).not.toHaveBeenCalled();
    timers.advance(100);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith("steady");
    lc.close();
  });

  it("transitions to steady mode after the eager window", () => {
    const timers = fakeTimers();
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 15_000,
      eagerDebounceMs: 100,
      steadyIntervalMs: 5_000,
      flushOnPagehide: false,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    lc.start(flush);
    expect(lc.getMode()).toBe("eager");
    timers.advance(15_001);
    expect(lc.getMode()).toBe("steady");
    lc.close();
  });
});

describe("LifecycleController — steady mode", () => {
  it("fires the flush callback on each interval tick", () => {
    const timers = fakeTimers();
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 0,
      eagerDebounceMs: 100,
      steadyIntervalMs: 5_000,
      flushOnPagehide: false,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    lc.start(flush);
    expect(lc.getMode()).toBe("steady");
    timers.advance(5_000);
    expect(flush).toHaveBeenCalledTimes(1);
    timers.advance(5_000);
    expect(flush).toHaveBeenCalledTimes(2);
    timers.advance(5_000);
    expect(flush).toHaveBeenCalledTimes(3);
    lc.close();
  });
});

describe("LifecycleController — pagehide", () => {
  it("installs a pagehide listener that triggers an urgent flush", async () => {
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 0,
      eagerDebounceMs: 100,
      steadyIntervalMs: 0,
      flushOnPagehide: true,
      window,
      document,
    });
    lc.start(flush);
    window.dispatchEvent(new Event("pagehide"));
    // Flush is fire-and-forget; await a microtask for the inner promise.
    await Promise.resolve();
    expect(flush).toHaveBeenCalledWith("urgent");
    lc.close();
  });

  it("does not install a pagehide listener when flushOnPagehide is false", async () => {
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 0,
      eagerDebounceMs: 100,
      steadyIntervalMs: 0,
      flushOnPagehide: false,
      window,
      document,
    });
    lc.start(flush);
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    lc.close();
  });
});

describe("LifecycleController — close", () => {
  it("cancels pending timers and detaches listeners", () => {
    const timers = fakeTimers();
    const flush = vi.fn(async () => undefined);
    const lc = new LifecycleController({
      eagerWindowMs: 15_000,
      eagerDebounceMs: 100,
      steadyIntervalMs: 5_000,
      flushOnPagehide: false,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    lc.start(flush);
    lc.notifyEnqueue();
    lc.close();
    timers.advance(15_001);
    expect(flush).not.toHaveBeenCalled();
    expect(lc.getMode()).toBe("closed");
  });

  it("is idempotent", () => {
    const lc = new LifecycleController({
      eagerWindowMs: 0,
      eagerDebounceMs: 100,
      steadyIntervalMs: 0,
      flushOnPagehide: false,
    });
    lc.start(vi.fn(async () => undefined));
    lc.close();
    expect(() => lc.close()).not.toThrow();
  });
});
