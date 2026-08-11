/**
 * `@polaris/consumer-clickhouse-sink-v1` public surface.
 *
 * The service is normally run as a binary (`node dist/main.js`); these
 * exports exist so tests and the acceptance harness can drive the runtime
 * in-process.
 */

export { buildClickhouseSinkApp, type BuildAppOptions, type ClickhouseSinkApp } from "./app.js";
export {
  type ClickhouseSinkConfig,
  clickhouseSinkConfigSchema,
  clickhouseSinkEnvKeys,
  clickhouseSinkEnvSchema,
  type ClickhouseSinkRuntimeConfig,
  loadClickhouseSinkConfig,
  SINK_COMPONENT,
  SINK_SERVICE_NAME,
} from "./config.js";
export {
  METRIC_SINK_BATCHES_TOTAL,
  METRIC_SINK_BATCH_ROWS_LAST,
  METRIC_SINK_INSERT_DURATION_MS_LAST,
  METRIC_SINK_LAG_SECONDS,
  METRIC_SINK_ROWS_CONSUMED_TOTAL,
  METRIC_SINK_ROWS_SKIPPED_TOTAL,
  SinkMetrics,
} from "./metrics.js";
export {
  type ClickhouseSinkRuntime,
  type ClickhouseSinkRuntimeDeps,
  createRuntime,
  toQueueRow,
} from "./runtime.js";
