#!/usr/bin/env node

// Polaris RabbitMQ topology provisioning.
//
// Kafka created topics on first publish. RabbitMQ creates nothing: an
// undeclared exchange drops publishes on the floor and an undeclared stream
// fails the consuming channel. This script is therefore a hard prerequisite
// for a working environment, not a convenience — `make up` runs it, CI runs
// it, and the acceptance suite runs it.
//
// What it declares (see packages/shared-transport/src/topology.ts, which is
// the single source of truth this script calls into):
//
//   - one super stream per canonical family: a direct exchange fronting N
//     partition streams bound with the partition index as routing key,
//     matching `rabbitmq-streams add_super_stream` exactly
//   - the SDK diagnostics stream (7-day retention)
//   - per-component retry tiers, redelivery queue, and DLQ
//
// Declarations are idempotent but NOT reconciling: AMQP rejects an assert
// whose arguments differ from the existing object. That is deliberate —
// changing a stream's retention or a super stream's width is a migration,
// not a restart. On PRECONDITION_FAILED this script reports the object and
// exits non-zero rather than deleting anything.
//
// Usage:
//   node scripts/rabbitmq-provision.mjs                # declare everything
//   node scripts/rabbitmq-provision.mjs --dry-run      # print the plan
//   node scripts/rabbitmq-provision.mjs --print-only   # alias for --dry-run
//
// Env vars (same names the services use, so a working service config is a
// working provisioning config):
//   POLARIS_RABBITMQ_URL                  default amqp://polaris:polaris@localhost:5672
//   POLARIS_RABBITMQ_PARTITIONS           default 3
//   POLARIS_RABBITMQ_PARTITION_OVERRIDES  default "raw.events=6"
//   POLARIS_RABBITMQ_STREAM_RETENTION_DAYS default 90

import {
  CANONICAL_STREAM_FAMILIES,
  DEFAULT_STREAM_MAX_BYTES,
  declareComponentQueues,
  declareSuperStream,
  POLARIS_COMPONENTS,
  RETRY_BACKOFF_TIERS_MS,
} from "@polaris/shared-transport";
import { connect } from "amqplib";

const DEFAULT_URL = "amqp://polaris:polaris@localhost:5672";
// raw.events carries every project's full firehose; the derived families
// carry a subset. Six partitions there and three elsewhere is the default
// documented in docs/implementation/rabbitmq-redesign-plan.md.
const DEFAULT_PARTITION_OVERRIDES = "raw.events=6";

function envOr(key, fallback) {
  const value = process.env[key];
  return value !== undefined && value !== "" ? value : fallback;
}

function parseOverrides(raw) {
  const out = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.lastIndexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid partition override "${trimmed}" (expected <family>=<count>)`);
    }
    const family = trimmed.slice(0, separator).trim();
    const count = Number(trimmed.slice(separator + 1).trim());
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`invalid partition count in "${trimmed}"`);
    }
    out[family] = count;
  }
  return out;
}

export function buildPlan(options = {}) {
  const partitions = Number(envOr("POLARIS_RABBITMQ_PARTITIONS", "3"));
  const overrides = parseOverrides(
    envOr("POLARIS_RABBITMQ_PARTITION_OVERRIDES", DEFAULT_PARTITION_OVERRIDES),
  );
  const retentionDays = Number(envOr("POLARIS_RABBITMQ_STREAM_RETENTION_DAYS", "90"));

  const widthFor = (family) => overrides[family] ?? partitions;

  // The SDK diagnostics stream is deliberately not declared: nothing
  // produces to it yet. See defaultSuperStreams() in
  // packages/shared-transport/src/topology.ts.
  const superStreams = CANONICAL_STREAM_FAMILIES.map((family) => ({
    family,
    partitions: widthFor(family),
    retentionDays,
    maxLengthBytes: DEFAULT_STREAM_MAX_BYTES,
  }));

  return {
    url: options.url ?? envOr("POLARIS_RABBITMQ_URL", DEFAULT_URL),
    superStreams,
    components: POLARIS_COMPONENTS.map((component) => ({ component })),
  };
}

function printPlan(plan) {
  console.log("RabbitMQ topology plan\n");
  console.log("super streams:");
  for (const spec of plan.superStreams) {
    console.log(
      `  ${spec.family.padEnd(30)} ${String(spec.partitions).padStart(2)} partitions` +
        `  age=${spec.retentionDays}D  max=${(spec.maxLengthBytes / 1024 ** 3).toFixed(0)}GiB`,
    );
    for (let p = 0; p < spec.partitions; p += 1) {
      console.log(`      stream ${spec.family}-${p}  <- routing key "${p}"`);
    }
  }
  console.log("\ncomponent queues:");
  for (const { component } of plan.components) {
    const tiers = RETRY_BACKOFF_TIERS_MS.map((t) => `${t / 1000}s`).join(", ");
    console.log(`  ${component.padEnd(22)} retry tiers [${tiers}] -> redeliver -> dlq`);
  }
}

export async function provision(plan, { logger = console } = {}) {
  const connection = await connect(plan.url, {
    clientProperties: { connection_name: "polaris-provision" },
  });
  const channel = await connection.createChannel();
  // A failed assert kills the channel, so surface the reason rather than
  // letting the process die with an unhandled 'error' event.
  channel.on("error", (err) => {
    logger.error(`channel error: ${err.message}`);
  });

  try {
    for (const spec of plan.superStreams) {
      await declareSuperStream(channel, spec);
      logger.info(`  ok  super stream ${spec.family} (${spec.partitions} partitions)`);
    }
    for (const { component } of plan.components) {
      await declareComponentQueues(channel, component);
      logger.info(`  ok  queues ${component}.retry.* / .redeliver / .dlq`);
    }
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("--print-only");
  const plan = buildPlan();

  if (dryRun) {
    printPlan(plan);
    return;
  }

  console.log(`provisioning RabbitMQ topology at ${redactUrl(plan.url)}`);
  try {
    await provision(plan);
  } catch (err) {
    console.error(`\nprovisioning failed: ${err.message}`);
    if (String(err.message).includes("PRECONDITION_FAILED")) {
      console.error(
        "\nAn existing object has different arguments than the declaration.\n" +
          "This is a topology migration, not a restart — see\n" +
          "docs/operations/runbook-rabbitmq-topology.md before deleting anything.",
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log("topology ready");
}

export function redactUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password !== "") parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
