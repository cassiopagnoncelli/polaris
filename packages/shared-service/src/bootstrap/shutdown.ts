import type { FastifyInstance } from "fastify";
import type { Logger } from "@polaris/shared-logger";

/**
 * POSIX signals that Polaris services treat as graceful-shutdown triggers.
 */
export const DEFAULT_SHUTDOWN_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGTERM", "SIGINT"];

/**
 * Async cleanup callback. Each callback is awaited in registration order
 * during shutdown. Throws are logged but do not stop the remaining
 * callbacks from running — partial cleanup is better than no cleanup.
 */
export type ShutdownTask = () => Promise<void> | void;

/**
 * Options for `installGracefulShutdown`.
 */
export interface GracefulShutdownOptions {
  /** Fastify instance to close as the first shutdown step. */
  readonly app: FastifyInstance;
  /** Logger used for shutdown bookkeeping lines. */
  readonly logger: Logger;
  /**
   * Hard upper bound (ms) before the shutdown gives up waiting and exits
   * non-zero. Container orchestrators usually deliver SIGKILL after their
   * own grace period; this timer is a belt-and-suspenders guard so a
   * stuck shutdown does not block container termination indefinitely.
   *
   * Defaults to 25_000 ms — generous for HTTP drain, tight enough that
   * Kubernetes's default 30s grace period still has 5s of slack.
   */
  readonly timeoutMs?: number;
  /**
   * Additional async cleanup tasks (close Kafka producer, Postgres pool,
   * Redis client, ClickHouse client, ...). Tasks run after Fastify has
   * finished accepting new requests so external clients are responsible
   * for retrying transient connection errors.
   */
  readonly tasks?: ReadonlyArray<ShutdownTask>;
  /**
   * Signals to listen for. Defaults to `SIGTERM` + `SIGINT`. Override when
   * embedding the bootstrap inside a parent process that prefers a custom
   * signalling channel.
   */
  readonly signals?: ReadonlyArray<NodeJS.Signals>;
  /**
   * Override of `process.exit`. Tests inject a spy so the harness never
   * actually exits.
   */
  readonly exit?: (code: number) => void;
}

/**
 * Install graceful shutdown handlers on the running process.
 *
 * Behavior on a registered signal:
 *
 *   1. Log the signal and start a hard timeout timer.
 *   2. Close the Fastify instance so the HTTP server stops accepting new
 *      connections and finishes in-flight requests.
 *   3. Run every additional task in registration order, awaiting each one.
 *      Task errors are logged but do not abort the remaining shutdown.
 *   4. Clear the hard timer and exit with code 0.
 *
 * If the hard timer fires first, the process exits with code 1 so
 * orchestrators record a non-zero termination.
 *
 * Multiple signals during one shutdown are de-duplicated; only the first
 * one performs cleanup, subsequent ones are logged and ignored.
 *
 * @returns a manual trigger function that simulates a signal — useful for
 *   tests and for shutdown initiated from inside the service (e.g.
 *   config-reload restart).
 */
export function installGracefulShutdown(
  options: GracefulShutdownOptions,
): (signal: NodeJS.Signals) => Promise<void> {
  const {
    app,
    logger,
    timeoutMs = 25_000,
    tasks = [],
    signals = DEFAULT_SHUTDOWN_SIGNALS,
    exit = (code: number) => process.exit(code),
  } = options;

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      logger.warn({ signal }, "graceful shutdown already in progress; ignoring signal");
      return;
    }
    shuttingDown = true;
    logger.info({ signal, timeout_ms: timeoutMs }, "graceful shutdown initiated");

    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const hardTimeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        logger.error(
          { signal, timeout_ms: timeoutMs },
          "graceful shutdown exceeded timeout; forcing exit",
        );
        resolve();
      }, timeoutMs);
      // Don't hold the event loop open just for the timer.
      timer.unref?.();
    });

    const drainPromise = (async () => {
      try {
        await app.close();
        logger.info("fastify server closed");
      } catch (err) {
        logger.error({ err }, "fastify close threw during shutdown");
      }
      for (const task of tasks) {
        try {
          await task();
        } catch (err) {
          logger.error({ err }, "shutdown task threw; continuing");
        }
      }
    })();

    await Promise.race([drainPromise, hardTimeout]);
    if (timer !== undefined) clearTimeout(timer);
    exit(timedOut ? 1 : 0);
  }

  for (const signal of signals) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  return shutdown;
}
