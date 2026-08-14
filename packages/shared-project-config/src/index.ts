/**
 * `@polaris/shared-project-config` — the read side of per-`(project,
 * environment)` configuration.
 *
 * Components receive their own namespace slice and nothing else: meta-capi
 * cannot read sessionizer's values, and no component can read another
 * project's. Values arrive RAW — this package applies no schema and no
 * defaults, because the component owns its schema and parses its own slice.
 *
 * That parse must run in strip mode, never `.strict()`. Projects may declare
 * keys no component schema knows (a future client-owned consumer has no schema
 * in this repo at all), so a strict parse would fail the moment an operator
 * declared any unfamiliar key — one free-form variable quarantining every
 * project. Strip mode makes undeclared keys inert instead.
 *
 * Typical wiring:
 *
 * ```ts
 * const store = createProjectConfigStore({
 *   db,
 *   listener: createPgListenerTransport({ connectionString, logger }),
 *   logger,
 * });
 * await store.start();
 *
 * const snapshot = await store.get({
 *   projectId: "storefront",
 *   environment: "production",
 *   namespace: "meta-capi",
 * });
 * const config = metaCapiProjectConfigSchema.parse(snapshot.values);
 * ```
 *
 * @see docs/implementation/project-config-plan.md
 */

export {
  CONFIG_NOTIFY_CHANNEL,
  DEFAULT_CACHE_CAPACITY,
  DEFAULT_SWEEP_INTERVAL_MS,
  SWEEP_JITTER_RATIO,
} from "./constants.js";
export {
  createDestinationProjectConfigLookup,
  type DestinationProjectConfigLookup,
} from "./destination-lookup.js";
export {
  PinMissingError,
  ProjectConfigAssemblyError,
  ProjectConfigError,
} from "./errors.js";
export {
  type ConfigChangeMessage,
  createPgListenerTransport,
  type ListenerHandlers,
  type ListenerTransport,
  type PgListenerTransportOptions,
  parseConfigChangeMessage,
} from "./listener.js";
export { isSecret, Secret } from "./secret-box.js";
export {
  createProjectConfigStore,
  type ProjectConfigMetricsHooks,
  type ProjectConfigStore,
  type ProjectConfigStoreOptions,
} from "./store.js";
export type { PinnedConfig, ProjectConfigKey, ProjectConfigSnapshot } from "./types.js";
