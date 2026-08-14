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
//   node scripts/rabbitmq-provision.mjs --destroy      # delete everything above
//
// `--destroy` is the inverse of a declare run and exists for one caller:
// `bin/setup`, which drops every Polaris store before rebuilding so a local
// install is a function of the repo rather than of its history. It deletes
// by name — the same names `buildPlan()` declares — so it can only ever
// remove objects this script created. It never deletes the vhost: the vhost
// is created by docker-compose on the container path, and
// `scripts/rabbitmq-bootstrap-local.mjs` can only recreate it bare-metal
// (it drives `rabbitmqctl` over Erlang distribution), so a deleted vhost
// would strand the docker path with no way back short of `make docker-nuke`.
//
// Env vars (same names the services use, so a working service config is a
// working provisioning config):
//   POLARIS_RABBITMQ_URL                  default amqp://polaris:polaris@localhost:5672
//   POLARIS_RABBITMQ_PARTITIONS           default 3
//   POLARIS_RABBITMQ_PARTITION_OVERRIDES  default "raw.events=6,identified.events=6,resolved.events=6"
//   POLARIS_RABBITMQ_STREAM_RETENTION_DAYS default 90

import {
  CANONICAL_STREAM_FAMILIES,
  DEFAULT_STREAM_MAX_BYTES,
  declareComponentQueues,
  declareSuperStream,
  defaultRetentionDaysForFamily,
  deleteComponentQueues,
  deleteSuperStream,
  POLARIS_COMPONENTS,
  RETRY_BACKOFF_TIERS_MS,
} from "@polaris/shared-transport";
import { connect } from "amqplib";

const DEFAULT_URL = "amqp://polaris:polaris@localhost:5672";
// raw.events carries every project's full firehose; the derived families
// carry a subset. Six partitions there and three elsewhere is the default
// documented in docs/implementation/rabbitmq-redesign-plan.md.
const DEFAULT_PARTITION_OVERRIDES = "raw.events=6,identified.events=6,resolved.events=6";

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
  //
  // Retention is delegated to defaultRetentionDaysForFamily() rather than
  // applied flat, because it is no longer uniform: `identified.events`
  // sits between the two spine stages and is fully regenerable from
  // `raw.events`, so it is capped short. This script used to compute the
  // spec itself, which meant a retention rule added in the package
  // silently did not reach the broker — declarations are idempotent but
  // NON-reconciling, so the wrong value would then persist until someone
  // migrated the stream by hand.
  const superStreams = CANONICAL_STREAM_FAMILIES.map((family) => ({
    family,
    partitions: widthFor(family),
    retentionDays: defaultRetentionDaysForFamily(retentionDays, family),
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

/**
 * Open a channel against the plan's broker, run `body`, always clean up.
 *
 * Shared by `provision` and `destroy` so both reach the broker the same
 * way — same URL resolution, same connection name, same teardown.
 */
async function withChannel(plan, connectionName, logger, body) {
  const connection = await connect(plan.url, {
    clientProperties: { connection_name: connectionName },
  });
  const channel = await connection.createChannel();
  // A failed assert kills the channel, so surface the reason rather than
  // letting the process die with an unhandled 'error' event.
  channel.on("error", (err) => {
    logger.error(`channel error: ${err.message}`);
  });

  try {
    await body(channel);
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

export async function provision(plan, { logger = console } = {}) {
  await withChannel(plan, "polaris-provision", logger, async (channel) => {
    for (const spec of plan.superStreams) {
      await declareSuperStream(channel, spec);
      logger.info(`  ok  super stream ${spec.family} (${spec.partitions} partitions)`);
    }
    for (const { component } of plan.components) {
      await declareComponentQueues(channel, component);
      logger.info(`  ok  queues ${component}.retry.* / .redeliver / .dlq`);
    }
  });
}

/**
 * Delete everything {@link provision} declares, by name.
 *
 * Component queues first, then super streams: consumers drain into the
 * retry/DLQ objects, so removing those first means the streams are not
 * dead-lettering into queues that have just disappeared.
 *
 * Deleting an object that is not there is not an error — RabbitMQ answers
 * `queue.delete` and `exchange.delete` for a missing object with success,
 * unlike the AMQP 0-9-1 spec. That is what makes this safe to run against
 * an empty broker, which is both the CI case and the re-run-after-a-crash
 * case.
 */
export async function destroy(plan, { logger = console } = {}) {
  await withChannel(plan, "polaris-destroy", logger, async (channel) => {
    for (const { component } of plan.components) {
      await deleteComponentQueues(channel, component);
      logger.info(`  gone  queues ${component}.retry.* / .redeliver / .dlq`);
    }
    for (const spec of plan.superStreams) {
      await deleteSuperStream(channel, spec);
      logger.info(`  gone  super stream ${spec.family} (${spec.partitions} partitions)`);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("--print-only");
  const destroying = args.includes("--destroy");
  const plan = buildPlan();

  if (dryRun) {
    printPlan(plan);
    return;
  }

  if (destroying) {
    console.log(`deleting RabbitMQ topology at ${redactUrl(plan.url)}`);
    try {
      await destroy(plan);
    } catch (err) {
      console.error(`\nteardown failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    console.log("topology deleted");
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
