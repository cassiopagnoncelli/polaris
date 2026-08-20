/**
 * Broker-neutral message shapes.
 *
 * These types are the contract between Polaris services and the transport
 * driver. Nothing here mentions AMQP, amqplib, or RabbitMQ: a service that
 * handles a `TransportMessagePayload` can be re-targeted at a different
 * broker by swapping the driver, which is exactly the coupling the old
 * `shared-kafka` package failed to prevent (it re-exported
 * KafkaJS's `EachMessagePayload` and handed out `.raw`).
 *
 * @see docs/architecture/03-rabbitmq-streams.md
 */

import type { MessageHeaders } from "./headers.js";

/**
 * A single message as delivered to a Polaris handler.
 *
 * `offset` is the position of the message inside its partition stream,
 * rendered as a decimal string. RabbitMQ stream offsets are 64-bit
 * unsigned integers; keeping the string form avoids precision loss and
 * matches the `source_offset text` columns in the DLQ tables.
 */
export interface TransportMessage {
  /** Raw message body. `null` for bodiless messages. */
  readonly value: Buffer | null;
  /**
   * Partition key the message was published with (the AMQP `messageId`
   * carries it; see `producer.ts`). `null` when the publisher did not set
   * one.
   */
  readonly key: string | null;
  /** Polaris platform headers plus any publisher-supplied extras. */
  readonly headers: MessageHeaders;
  /** Stream offset, decimal string. */
  readonly offset: string;
  /** Broker enqueue time in epoch milliseconds, decimal string. */
  readonly timestamp: string;
  /** True when the broker has delivered this message before. */
  readonly redelivered: boolean;
}

/**
 * Delivery envelope handed to `TransportMessageHandler`.
 *
 * `stream` is the concrete partition stream the message was read from
 * (e.g. `raw.events-2`); `family` is the logical family it belongs to
 * (`raw.events`). Handlers that log or stamp lineage should prefer
 * `family` for aggregation and `stream` for pinpointing.
 */
export interface TransportMessagePayload {
  /** Concrete partition stream name. */
  readonly stream: string;
  /** Logical stream family the concrete stream belongs to. */
  readonly family: string;
  /** Partition index within the family's super stream. */
  readonly partition: number;
  /** The delivered message. */
  readonly message: TransportMessage;
}

/**
 * Polaris platform header context extracted by the consumer so handlers do
 * not have to re-parse the header bag. Fields are best-effort: a message
 * published outside Polaris (or an early-boot diagnostic) may be missing
 * any of them.
 */
export interface TransportMessageContext {
  readonly event_id?: string;
  readonly project_id?: string;
  readonly environment?: string;
  readonly topic_family?: string;
}

/**
 * Per-message handler signature.
 *
 * Throwing from a handler means "this message was not processed". The
 * consumer does not advance its checkpoint past a throwing message; it
 * rewinds to the last checkpoint and re-delivers (see
 * `consumer.ts` — `restartOnHandlerError`). Components that want
 * retry/DLQ routing instead of redelivery catch the error themselves and
 * call the helpers in `./dlq`.
 */
export type TransportMessageHandler = (
  payload: TransportMessagePayload,
  context: TransportMessageContext,
) => Promise<void>;

/** Result of a publish call. Mirrors the small slice of metadata Polaris uses. */
export interface PublishResult {
  /** Concrete partition stream the message was routed to. */
  readonly stream: string;
  /** Partition index the routing key resolved to. */
  readonly partition: number;
}
