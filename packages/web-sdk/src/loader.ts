/**
 * Async script loader with a pre-init command queue.
 *
 * Per `docs/architecture/10-sdk-standards.md` § Script Loader:
 *
 *   - Script-tag users get a lightweight inline loader snippet.
 *   - The loader defines a temporary global API.
 *   - Calls before full SDK load are queued.
 *   - The full SDK loads asynchronously.
 *   - Queued calls are drained after initialization.
 *   - The loader supports early `track`, `identify`, `reset`, and `flush`
 *     calls.
 *   - The snippet stays small and stable.
 *   - The full SDK preserves event order for queued calls where possible.
 *
 * The IIFE/UMD bundle that ships the inline snippet is an explicit future
 * task per the task card (the doc lists IIFE bundle under SDK Distribution
 * as a separate concern). This module ships the typed glue that the
 * bundle will wrap: a queue type, a queue executor, and a tiny inline
 * snippet template operators can drop into their HTML before P3-003's
 * full bundle work in P12.
 */

import type { PolarisWebSdk } from "./sdk.js";

/** Recognized pre-init commands queued by the loader snippet. */
export type LoaderCommand =
  | readonly ["track", string, Record<string, unknown>?]
  | readonly ["identify", string, Record<string, unknown>?]
  | readonly ["reset", { readonly anonymous?: boolean }?]
  | readonly ["flush"];

/**
 * Queue type matching the inline snippet's `polaris.q.push(args)` shape.
 *
 * The snippet exposes a global `polaris` whose `.q` array buffers any
 * call made before the full SDK script has loaded. The snippet uses
 * `arguments` to capture the method name plus its arguments as a single
 * tuple — see {@link INLINE_LOADER_SNIPPET}.
 */
export type LoaderQueue = LoaderCommand[];

/**
 * Drain a pre-init queue into a freshly-constructed SDK. Order is
 * preserved. Unknown commands are logged via `onUnknownCommand` (if
 * supplied) and skipped — the snippet is forward-compatible: a future
 * release that adds a new method should not break a stale loader snippet.
 *
 * Errors thrown by individual commands are swallowed and forwarded to
 * `onCommandError` so a malformed early `track` does not abort the
 * remaining queue.
 */
export interface DrainQueueOptions {
  readonly onUnknownCommand?: (command: LoaderCommand) => void;
  readonly onCommandError?: (command: LoaderCommand, error: Error) => void;
}

export async function drainLoaderQueue(
  sdk: PolarisWebSdk,
  queue: LoaderQueue,
  options: DrainQueueOptions = {},
): Promise<void> {
  for (const command of queue) {
    try {
      switch (command[0]) {
        case "track": {
          const [, event, properties] = command;
          // track() is async but the loader does not await; the SDK's own
          // queue absorbs the event so callers can keep chaining.
          await sdk.track(event, properties);
          break;
        }
        case "identify": {
          const [, customerId, traits] = command;
          sdk.identify(customerId, traits);
          break;
        }
        case "reset": {
          const [, opts] = command;
          sdk.reset(opts);
          break;
        }
        case "flush": {
          await sdk.flush();
          break;
        }
        default: {
          options.onUnknownCommand?.(command);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      options.onCommandError?.(command, error);
    }
  }
}

/**
 * The inline snippet operators drop into their `<head>`. The full SDK
 * bundle reads the queue at startup and calls `drainLoaderQueue`.
 *
 * Stub-only string for v1 — the full IIFE bundle that owns this surface
 * is the explicit P12-001 task. The text below is the minimum so callers
 * (and our docs) can wire the SDK against a pre-init queue today.
 */
export const INLINE_LOADER_SNIPPET = `
(function(w){
  if (w.polaris && w.polaris.q) return;
  var q = [];
  var stub = function(method){ return function(){
    q.push([method].concat(Array.prototype.slice.call(arguments)));
  };};
  w.polaris = {
    q: q,
    track: stub("track"),
    identify: stub("identify"),
    reset: stub("reset"),
    flush: stub("flush")
  };
})(window);
`.trim();
