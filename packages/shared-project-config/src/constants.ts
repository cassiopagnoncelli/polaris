/**
 * Tuning constants for the project-config read store.
 *
 * @see docs/implementation/project-config-plan.md §4
 */

/**
 * PostgreSQL `NOTIFY` channel carrying config changes.
 *
 * The writer issues `pg_notify` inside the same transaction as the value
 * write and version bump; PostgreSQL delivers only on commit, so a rolled-back
 * write never announces itself.
 */
export const CONFIG_NOTIFY_CHANNEL = "polaris_config_changed";

/**
 * Maximum cached snapshots per process.
 *
 * Entries are projects × environments × namespaces-this-process-reads, and a
 * destination consumer reads exactly one namespace — so this sits far above
 * any realistic fleet. A non-zero eviction rate means the bound is wrong, not
 * that the cache is working; evictions are metered for that reason.
 */
export const DEFAULT_CACHE_CAPACITY = 4096;

/**
 * How often the background sweep reconciles cached versions against the
 * database, in milliseconds.
 *
 * This is the backstop that makes a lost notification self-healing rather than
 * permanent — `NOTIFY` is fire-and-forget, so a subscriber reconnecting when a
 * message fires never sees it. One batched query per tick regardless of how
 * many scopes are cached.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 10_000;

/**
 * Jitter applied to each sweep tick, as a fraction of the interval.
 *
 * Without it, a fleet deployed together sweeps in lockstep forever.
 */
export const SWEEP_JITTER_RATIO = 0.2;

/*
 * There is deliberately no secret-refresh deadline here.
 *
 * One existed while secrets were `provider:ref` pointers: version-based
 * invalidation was structurally blind to rotation, because rotating a
 * credential in Vault does not touch `project_config`, so the version never
 * moved and neither `NOTIFY` nor the sweep fired. A cached snapshot could hold
 * a revoked credential indefinitely, and a five-minute deadline capped that.
 *
 * Secrets are now stored values, not pointers. A secret changes only by a
 * write to `project_config`, which bumps the version and fires `NOTIFY` in the
 * same transaction — the two mechanisms above already cover it exactly as they
 * cover every other key. A deadline on top would be a periodic refetch that
 * can never observe a change the version did not already announce.
 */
