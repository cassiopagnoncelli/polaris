/**
 * Topology declaration.
 *
 * Kafka created topics on first publish. RabbitMQ creates nothing: an
 * undeclared exchange silently drops publishes, and an undeclared stream
 * fails the consuming channel. So Polaris declares its whole topology
 * explicitly, and does it from code that both services and the
 * provisioning script share — a stream declared one way by an operator and
 * another way by a booting service is the class of drift this module
 * exists to prevent.
 *
 * Declarations are idempotent (`assert*`), but **not** reconciling: AMQP
 * rejects an assert whose arguments differ from the existing object with a
 * `PRECONDITION_FAILED` channel error. That is the desired behaviour —
 * changing a stream's retention or a super stream's width is a migration,
 * not a restart. `docs/operations/runbook-rabbitmq-topology.md` covers the
 * procedure.
 *
 * @see docs/architecture/03-rabbitmq-streams.md
 */

import { type RabbitmqConfig, partitionsForFamily } from "@polaris/shared-config";
import type { Logger } from "@polaris/shared-logger";
import type { Channel } from "amqplib";
import type { TransportConnection } from "./connection.js";
import {
  CANONICAL_STREAM_FAMILIES,
  RETRY_BACKOFF_TIERS_MS,
  STREAM_DIAGNOSTICS_EVENTS,
  dlqQueueName,
  partitionStreamName,
  redeliverQueueName,
  retryExchangeName,
  retryQueueName,
  streamExchangeName,
} from "./streams.js";

/** Retention for the SDK diagnostics stream. Short by design. */
export const DIAGNOSTICS_RETENTION_DAYS = 7;

/**
 * Per-stream storage cap. RabbitMQ streams need a size bound as well as an
 * age bound: without `x-max-length-bytes` a traffic spike inside the
 * retention window can fill the disk, and a full disk blocks publishes
 * cluster-wide. 20 GiB per partition stream is the v1 default; production
 * sizing lives in `docs/operations/backup-and-retention.md`.
 */
export const DEFAULT_STREAM_MAX_BYTES = 20 * 1024 * 1024 * 1024;

/** A super stream: one direct exchange fronting N partition streams. */
export interface SuperStreamSpec {
  readonly family: string;
  readonly partitions: number;
  readonly retentionDays: number;
  readonly maxLengthBytes: number;
}

/** A component's retry / redelivery / DLQ queue set. */
export interface ComponentQueueSpec {
  readonly component: string;
}

export interface DeclareTopologyInput {
  /** Super streams to declare. */
  readonly superStreams: ReadonlyArray<SuperStreamSpec>;
  /** Components whose retry/redeliver/DLQ queues to declare. */
  readonly components: ReadonlyArray<ComponentQueueSpec>;
}

/**
 * Build the default topology for an environment: every canonical stream
 * family plus the diagnostics stream, sized from config.
 *
 * Dedicated per-project families are **not** included: they are created by
 * the isolation cutover procedure, which is a deliberate operator action.
 */
export function defaultSuperStreams(config: RabbitmqConfig): ReadonlyArray<SuperStreamSpec> {
  const canonical = CANONICAL_STREAM_FAMILIES.map((family) => ({
    family,
    partitions: partitionsForFamily(config, family),
    retentionDays: config.streamRetentionDays,
    maxLengthBytes: DEFAULT_STREAM_MAX_BYTES,
  }));
  return [
    ...canonical,
    {
      family: STREAM_DIAGNOSTICS_EVENTS,
      partitions: partitionsForFamily(config, STREAM_DIAGNOSTICS_EVENTS),
      retentionDays: DIAGNOSTICS_RETENTION_DAYS,
      maxLengthBytes: DEFAULT_STREAM_MAX_BYTES,
    },
  ];
}

/** Every Polaris component that owns a retry/DLQ queue set. */
export const POLARIS_COMPONENTS = [
  "geoip-enricher",
  "sessionizer",
  "identity-resolver",
  "attribution-engine",
  "analytics-projector",
  "clickhouse-sink",
  "braze",
  "ga4",
  "meta-capi",
  "tiktok",
  "webhook-sink",
] as const;

/**
 * Declare a topology on an open channel.
 *
 * The channel is used and left open; callers own its lifecycle. Any
 * mismatch with an existing object throws (see the module note).
 */
export async function declareTopologyOnChannel(
  channel: Channel,
  input: DeclareTopologyInput,
  logger?: Logger,
): Promise<void> {
  for (const spec of input.superStreams) {
    await declareSuperStream(channel, spec);
    logger?.info(
      {
        component: "transport.topology",
        family: spec.family,
        partitions: spec.partitions,
        retention_days: spec.retentionDays,
      },
      "declared super stream",
    );
  }
  for (const spec of input.components) {
    await declareComponentQueues(channel, spec.component);
    logger?.info(
      { component: "transport.topology", target: spec.component },
      "declared component retry/dlq queues",
    );
  }
}

/**
 * Declare a topology using a short-lived channel from `connection`.
 */
export async function declareTopology(
  connection: TransportConnection,
  input: DeclareTopologyInput,
  logger?: Logger,
): Promise<void> {
  const channel = await connection.createChannel();
  try {
    await declareTopologyOnChannel(channel, input, logger);
  } finally {
    await channel.close().catch(() => undefined);
  }
}

/**
 * Declare one super stream: the direct exchange, its partition streams,
 * and the index bindings.
 *
 * The layout matches `rabbitmq-streams add_super_stream` exactly, so the
 * management CLI and the native stream protocol client see the same
 * object graph this package creates.
 */
export async function declareSuperStream(channel: Channel, spec: SuperStreamSpec): Promise<void> {
  const exchange = streamExchangeName(spec.family);
  await channel.assertExchange(exchange, "direct", { durable: true });
  for (let partition = 0; partition < spec.partitions; partition += 1) {
    const stream = partitionStreamName(spec.family, partition);
    await channel.assertQueue(stream, {
      durable: true,
      arguments: {
        "x-queue-type": "stream",
        "x-max-age": `${spec.retentionDays}D`,
        "x-max-length-bytes": spec.maxLengthBytes,
      },
    });
    await channel.bindQueue(stream, exchange, String(partition));
  }
}

/**
 * Declare a component's retry tiers, redelivery queue, and DLQ.
 *
 * ```text
 *   <component>.retry.5000     ttl 5s    ─┐
 *   <component>.retry.30000    ttl 30s    ├─ expire ─> <component>.retry.dlx
 *   ...                                  ─┘                   │  rk=redeliver
 *                                                             v
 *                                             <component>.redeliver
 *                                                             │  delivery-limit
 *                                                             │  exhausted
 *                                                             v  rk=dlq
 *   <component>.dlq            terminal   <───────── <component>.retry.dlx
 * ```
 *
 * The redelivery queue dead-letters into the DLQ so a message that keeps
 * failing after requeue (a poison payload the handler cannot classify)
 * lands somewhere an operator can see it, instead of being dropped when
 * the quorum queue's delivery limit is reached.
 */
export async function declareComponentQueues(channel: Channel, component: string): Promise<void> {
  const dlx = retryExchangeName(component);
  const redeliver = redeliverQueueName(component);
  const dlq = dlqQueueName(component);

  await channel.assertExchange(dlx, "direct", { durable: true });

  await channel.assertQueue(dlq, { durable: true, arguments: quorumArgs() });
  await channel.bindQueue(dlq, dlx, dlq);

  await channel.assertQueue(redeliver, {
    durable: true,
    arguments: {
      ...quorumArgs(),
      "x-dead-letter-exchange": dlx,
      "x-dead-letter-routing-key": dlq,
    },
  });
  await channel.bindQueue(redeliver, dlx, redeliver);

  for (const tier of RETRY_BACKOFF_TIERS_MS) {
    await channel.assertQueue(retryQueueName(component, tier), {
      durable: true,
      arguments: {
        ...quorumArgs(),
        "x-message-ttl": tier,
        "x-dead-letter-exchange": dlx,
        "x-dead-letter-routing-key": redeliver,
      },
    });
  }
}

/**
 * Shared quorum-queue arguments.
 *
 * `x-dead-letter-strategy: at-least-once` (with `x-overflow:
 * reject-publish`, which it requires) closes the window where a
 * dead-lettered message is lost if the node moving it crashes. The
 * trade-off is that a retry tier which somehow fills up rejects publishes
 * instead of silently dropping — the right failure for a pipeline that
 * records every failed event in PostgreSQL anyway.
 */
function quorumArgs(): Record<string, unknown> {
  return {
    "x-queue-type": "quorum",
    "x-overflow": "reject-publish",
    "x-dead-letter-strategy": "at-least-once",
  };
}
