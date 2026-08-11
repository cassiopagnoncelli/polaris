/**
 * Next calls `register()` once per server runtime, before the first request.
 *
 * Constructing the SDK here means the first checkout does not pay for it,
 * and it is the natural place to wire process-level concerns. The signal
 * handling itself is the SDK's (`autoFlushOnShutdown: true` in
 * `lib/polaris.ts`) — this file just makes sure the instance exists early
 * enough for those handlers to be installed.
 */
export async function register(): Promise<void> {
  // `register()` also runs in the edge runtime, where `node:https` and
  // process signals do not exist.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getPolaris } = await import("./lib/polaris");
  try {
    getPolaris();
    console.log("[polaris] node sdk ready");
  } catch (error) {
    // A missing key should fail the request that needs it, not the boot.
    console.warn(`[polaris] not initialised: ${(error as Error).message}`);
  }
}
