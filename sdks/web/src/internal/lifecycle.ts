/**
 * `LifecycleController` — orchestrates the three flush phases described in
 * `docs/architecture/10-sdk-standards.md` § Web SDK Flush Lifecycle:
 *
 *   0-15s after SDK init       eager flush mode
 *   after 15s                 steady batch mode
 *   pagehide/manual flush      urgent flush mode
 *
 * Eager mode coalesces a `track()` burst into one request by waiting
 * `startupEagerFlushDebounceMs` (default 100ms) before firing. After the
 * eager window expires, steady mode flushes every `steadyFlushIntervalMs`
 * (default 5s) when there is queued work.
 *
 * Page-exit flushing is best-effort per the doc — it uses `sendBeacon`
 * with a `fetch` keepalive fallback inside the transport. The lifecycle
 * controller wires the pagehide/visibilitychange listener and triggers
 * an urgent flush; we do NOT block on the flush completing, because the
 * tab is racing the unload.
 *
 * The controller is intentionally tiny: it knows about windows, debounces,
 * intervals, and event listeners. It does not own the queue, the
 * transport, or retry — the SDK class owns those and passes the "flush
 * now in mode X" callback into the controller.
 */

import type { TransportMode } from "../types.js";

export type FlushCallback = (mode: TransportMode) => Promise<unknown>;

/**
 * Timer defaults, wrapped rather than referenced.
 *
 * `window.setTimeout` and friends are native methods that must be invoked
 * with the global object as their receiver. Storing a bare reference and
 * calling it as `this.options.setTimeoutFn(...)` hands them the options
 * object instead, and every browser answers with
 * `TypeError: Illegal invocation`. The unit suite runs on happy-dom, whose
 * timers are ordinary functions and never notice.
 */
const defaultSetTimeout = (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> =>
  setTimeout(...args);
const defaultClearTimeout = (...args: Parameters<typeof clearTimeout>): void =>
  clearTimeout(...args);
const defaultSetInterval = (
  ...args: Parameters<typeof setInterval>
): ReturnType<typeof setInterval> => setInterval(...args);
const defaultClearInterval = (...args: Parameters<typeof clearInterval>): void =>
  clearInterval(...args);

export interface LifecycleControllerOptions {
  readonly eagerWindowMs: number;
  readonly eagerDebounceMs: number;
  readonly steadyIntervalMs: number;
  readonly flushOnPagehide: boolean;
  readonly window?: Window | undefined;
  readonly document?: Document | undefined;
  /** Optional clock injection for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Optional `setTimeout` injection for tests. */
  readonly setTimeoutFn?: typeof setTimeout;
  /** Optional `clearTimeout` injection for tests. */
  readonly clearTimeoutFn?: typeof clearTimeout;
  /** Optional `setInterval` injection for tests. */
  readonly setIntervalFn?: typeof setInterval;
  /** Optional `clearInterval` injection for tests. */
  readonly clearIntervalFn?: typeof clearInterval;
}

export class LifecycleController {
  private readonly options: Required<Omit<LifecycleControllerOptions, "window" | "document">> & {
    readonly window: Window | undefined;
    readonly document: Document | undefined;
  };
  private readonly listeners: Array<() => void> = [];

  private flushCallback: FlushCallback | undefined;
  private eagerDebounceHandle: ReturnType<typeof setTimeout> | undefined;
  private steadyIntervalHandle: ReturnType<typeof setInterval> | undefined;
  private switchTimerHandle: ReturnType<typeof setTimeout> | undefined;
  private mode: "eager" | "steady" | "closed" = "eager";

  public constructor(options: LifecycleControllerOptions) {
    if (!Number.isFinite(options.eagerWindowMs) || options.eagerWindowMs < 0) {
      throw new Error("LifecycleController: eagerWindowMs must be >= 0");
    }
    if (!Number.isFinite(options.eagerDebounceMs) || options.eagerDebounceMs < 0) {
      throw new Error("LifecycleController: eagerDebounceMs must be >= 0");
    }
    if (!Number.isFinite(options.steadyIntervalMs) || options.steadyIntervalMs < 0) {
      throw new Error("LifecycleController: steadyIntervalMs must be >= 0");
    }
    this.options = {
      eagerWindowMs: options.eagerWindowMs,
      eagerDebounceMs: options.eagerDebounceMs,
      steadyIntervalMs: options.steadyIntervalMs,
      flushOnPagehide: options.flushOnPagehide,
      window: options.window,
      document: options.document,
      now: options.now ?? (() => Date.now()),
      setTimeoutFn: options.setTimeoutFn ?? defaultSetTimeout,
      clearTimeoutFn: options.clearTimeoutFn ?? defaultClearTimeout,
      setIntervalFn: options.setIntervalFn ?? defaultSetInterval,
      clearIntervalFn: options.clearIntervalFn ?? defaultClearInterval,
    };
  }

  /** Wire the flush callback. Must be called once at SDK construction. */
  public start(flushCallback: FlushCallback): void {
    this.flushCallback = flushCallback;
    this.scheduleEagerToSteadySwitch();
    this.installPagehideListener();
  }

  /**
   * Notify the controller that a new event was enqueued. In eager mode the
   * controller starts (or restarts) a 100ms debounce that fires the flush
   * callback. In steady mode this is a no-op — the steady interval
   * handles flushing.
   */
  public notifyEnqueue(): void {
    if (this.mode === "closed") return;
    if (this.mode === "eager") {
      this.scheduleEagerFlush();
    }
  }

  /** Current lifecycle mode (for diagnostics). */
  public getMode(): "eager" | "steady" | "closed" {
    return this.mode;
  }

  /**
   * Tear down timers and listeners. Idempotent. Does NOT trigger a final
   * flush — the SDK's `close()` is responsible for that orchestration if
   * desired.
   */
  public close(): void {
    if (this.mode === "closed") return;
    this.mode = "closed";
    if (this.eagerDebounceHandle !== undefined) {
      this.options.clearTimeoutFn(this.eagerDebounceHandle);
      this.eagerDebounceHandle = undefined;
    }
    if (this.steadyIntervalHandle !== undefined) {
      this.options.clearIntervalFn(this.steadyIntervalHandle);
      this.steadyIntervalHandle = undefined;
    }
    if (this.switchTimerHandle !== undefined) {
      this.options.clearTimeoutFn(this.switchTimerHandle);
      this.switchTimerHandle = undefined;
    }
    for (const remove of this.listeners) {
      try {
        remove();
      } catch {
        // Best-effort teardown.
      }
    }
    this.listeners.length = 0;
  }

  // ---- internal --------------------------------------------------------

  private scheduleEagerFlush(): void {
    if (this.eagerDebounceHandle !== undefined) {
      this.options.clearTimeoutFn(this.eagerDebounceHandle);
    }
    this.eagerDebounceHandle = this.options.setTimeoutFn(() => {
      this.eagerDebounceHandle = undefined;
      this.triggerFlush("steady");
    }, this.options.eagerDebounceMs);
  }

  private scheduleEagerToSteadySwitch(): void {
    const eagerWindow = this.options.eagerWindowMs;
    if (eagerWindow === 0) {
      // No eager window — start in steady mode immediately.
      this.mode = "steady";
      this.installSteadyInterval();
      return;
    }
    this.switchTimerHandle = this.options.setTimeoutFn(() => {
      this.switchTimerHandle = undefined;
      this.switchToSteady();
    }, eagerWindow);
  }

  private switchToSteady(): void {
    if (this.mode === "closed") return;
    this.mode = "steady";
    if (this.eagerDebounceHandle !== undefined) {
      // Flush whatever was pending in eager mode immediately rather than
      // letting it linger until the next steady tick.
      this.options.clearTimeoutFn(this.eagerDebounceHandle);
      this.eagerDebounceHandle = undefined;
      this.triggerFlush("steady");
    }
    this.installSteadyInterval();
  }

  private installSteadyInterval(): void {
    const interval = this.options.steadyIntervalMs;
    if (interval === 0) return;
    this.steadyIntervalHandle = this.options.setIntervalFn(() => {
      this.triggerFlush("steady");
    }, interval);
  }

  private installPagehideListener(): void {
    if (!this.options.flushOnPagehide) return;
    const win = this.options.window;
    if (win === undefined) return;
    const handler = (): void => {
      this.triggerFlush("urgent");
    };
    const addEvent = (target: EventTarget | undefined, eventName: string): void => {
      if (target === undefined) return;
      try {
        target.addEventListener(eventName, handler);
        this.listeners.push(() => target.removeEventListener(eventName, handler));
      } catch {
        // Some test environments expose `addEventListener` only on document.
      }
    };
    addEvent(win, "pagehide");
    addEvent(this.options.document, "visibilitychange");
  }

  private triggerFlush(mode: TransportMode): void {
    if (this.mode === "closed") return;
    if (this.flushCallback === undefined) return;
    // Fire-and-forget — the SDK class chains its own promises and surfaces
    // errors via `onError`. The lifecycle controller doesn't await.
    Promise.resolve(this.flushCallback(mode)).catch(() => {
      // Errors propagate via the flush callback's own diagnostic path.
    });
  }
}
