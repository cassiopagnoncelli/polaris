import { z } from "zod";
import {
  booleanFromStringSchema,
  durationMsSchema,
  nonEmptyStringSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
} from "./common.js";

/**
 * RabbitMQ transport config.
 *
 * Polaris services talk to RabbitMQ through `@polaris/shared-transport`.
 * This schema produces the values that package needs and nothing more —
 * the driver itself owns producer/consumer tuning defaults.
 *
 * Env vars:
 *
 *   POLARIS_RABBITMQ_URL              required — amqp(s)://user:pass@host:port/vhost
 *   POLARIS_RABBITMQ_MANAGEMENT_URL   (optional) — http(s) management API, used by
 *                                     provisioning + operational tooling only
 *   POLARIS_RABBITMQ_CLIENT_ID        required — connection name shown in the
 *                                     management UI (defaults to the service name)
 *   POLARIS_RABBITMQ_TLS              (false) — enable TLS verification options
 *   POLARIS_RABBITMQ_HEARTBEAT_SECONDS       (30)
 *   POLARIS_RABBITMQ_CONNECTION_TIMEOUT_MS   (10000)
 *   POLARIS_RABBITMQ_PARTITIONS              (3)  — default super-stream width
 *   POLARIS_RABBITMQ_PARTITION_OVERRIDES     (empty) — `raw.events=6,analytics.events=3`
 *   POLARIS_RABBITMQ_ASSIGNED_PARTITIONS     (empty = all) — `0,1,2` static assignment
 *   POLARIS_RABBITMQ_PREFETCH                (100) — per-partition QoS window
 *   POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS  (5000)
 *   POLARIS_RABBITMQ_CHECKPOINT_EVERY        (500) — messages between checkpoints
 *   POLARIS_RABBITMQ_STREAM_RETENTION_DAYS   (90)
 *
 * Credentials live in the URL because that is the shape every RabbitMQ
 * client, CLI, and operator runbook already uses. The URL is a secret and
 * is resolved through `@polaris/shared-secrets` in deployed environments.
 */

/**
 * Parse `family=count` pairs into a map, collecting problems rather than
 * throwing, so both callers can report them in their own idiom.
 *
 * Exported because the partition width of a family is a WIRE CONTRACT: the
 * publisher hashes the partition key modulo the width, so a provisioner and
 * a running service that disagree about it break per-identity ordering
 * outright. `scripts/rabbitmq-provision.mjs` used to carry its own copy of
 * this logic — the two happened to agree, but nothing made them, and the
 * value they parse is the one thing that must never diverge.
 */
export function parsePartitionOverrides(raw: string): {
  readonly overrides: Readonly<Record<string, number>>;
  readonly problems: readonly string[];
} {
  const overrides: Record<string, number> = {};
  const problems: string[] = [];
  const trimmedRaw = raw.trim();
  if (trimmedRaw.length === 0) {
    return { overrides: Object.freeze({}), problems: Object.freeze([]) };
  }
  for (const entry of trimmedRaw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.lastIndexOf("=");
    if (separator <= 0) {
      problems.push(`partition override "${trimmed}" must use the form <family>=<count>`);
      continue;
    }
    const family = trimmed.slice(0, separator).trim();
    const count = Number(trimmed.slice(separator + 1).trim());
    if (family.length === 0 || !Number.isInteger(count) || count < 1) {
      problems.push(`partition override "${trimmed}" must use the form <family>=<count>`);
      continue;
    }
    overrides[family] = count;
  }
  return { overrides: Object.freeze(overrides), problems: Object.freeze(problems) };
}

/**
 * Parse `family=count` pairs into a map. Invalid entries fail the whole
 * config load: a typo here would silently publish to the wrong partition
 * count and break per-identity ordering.
 */
const partitionOverridesSchema = z
  .string()
  .trim()
  .default("")
  .transform((raw, ctx): Readonly<Record<string, number>> => {
    // Delegates to the exported parser so the provisioning script and the
    // running services cannot drift on a wire contract — see
    // `parsePartitionOverrides`.
    const { overrides, problems } = parsePartitionOverrides(raw);
    for (const message of problems) {
      ctx.addIssue({ code: "custom", message });
    }
    return overrides;
  });

/**
 * Static partition assignment. Empty means "this instance owns every
 * partition", which is the correct default for single-instance
 * deployments and for local development.
 */
const assignedPartitionsSchema = z
  .string()
  .trim()
  .default("")
  .transform((raw, ctx): ReadonlyArray<number> => {
    if (raw.length === 0) return Object.freeze([]);
    const out: number[] = [];
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 0) {
        ctx.addIssue({
          code: "custom",
          message: `assigned partition "${trimmed}" must be a non-negative integer`,
        });
        continue;
      }
      out.push(parsed);
    }
    return Object.freeze([...new Set(out)].sort((a, b) => a - b));
  });

export const rabbitmqEnvSchema = z
  .object({
    POLARIS_RABBITMQ_URL: nonEmptyStringSchema,
    POLARIS_RABBITMQ_MANAGEMENT_URL: nonEmptyStringSchema.optional(),
    POLARIS_RABBITMQ_CLIENT_ID: nonEmptyStringSchema,
    POLARIS_RABBITMQ_TLS: booleanFromStringSchema.default(false),
    POLARIS_RABBITMQ_HEARTBEAT_SECONDS: nonNegativeIntSchema.default(30),
    POLARIS_RABBITMQ_CONNECTION_TIMEOUT_MS: durationMsSchema.default(10_000),
    POLARIS_RABBITMQ_PARTITIONS: positiveIntSchema.default(3),
    POLARIS_RABBITMQ_PARTITION_OVERRIDES: partitionOverridesSchema,
    POLARIS_RABBITMQ_ASSIGNED_PARTITIONS: assignedPartitionsSchema,
    POLARIS_RABBITMQ_PREFETCH: positiveIntSchema.default(100),
    POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS: durationMsSchema.default(5_000),
    POLARIS_RABBITMQ_CHECKPOINT_EVERY: positiveIntSchema.default(500),
    POLARIS_RABBITMQ_STREAM_RETENTION_DAYS: positiveIntSchema.default(90),
  })
  .superRefine((parsed, ctx) => {
    const url = parsed.POLARIS_RABBITMQ_URL;
    if (!/^amqps?:\/\//.test(url)) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_RABBITMQ_URL"],
        message: "POLARIS_RABBITMQ_URL must start with amqp:// or amqps://",
      });
    }
    if (parsed.POLARIS_RABBITMQ_TLS && url.startsWith("amqp://")) {
      ctx.addIssue({
        code: "custom",
        path: ["POLARIS_RABBITMQ_TLS"],
        message:
          "POLARIS_RABBITMQ_TLS is enabled but POLARIS_RABBITMQ_URL uses the plaintext amqp:// scheme",
      });
    }
    const max = Math.max(
      parsed.POLARIS_RABBITMQ_PARTITIONS,
      ...Object.values(parsed.POLARIS_RABBITMQ_PARTITION_OVERRIDES),
    );
    for (const partition of parsed.POLARIS_RABBITMQ_ASSIGNED_PARTITIONS) {
      if (partition >= max) {
        ctx.addIssue({
          code: "custom",
          path: ["POLARIS_RABBITMQ_ASSIGNED_PARTITIONS"],
          message: `assigned partition ${partition} is outside the widest configured super stream (${max} partitions)`,
        });
      }
    }
  })
  .transform(
    (parsed): RabbitmqConfig => ({
      url: parsed.POLARIS_RABBITMQ_URL,
      managementUrl: parsed.POLARIS_RABBITMQ_MANAGEMENT_URL,
      clientId: parsed.POLARIS_RABBITMQ_CLIENT_ID,
      tls: parsed.POLARIS_RABBITMQ_TLS,
      heartbeatSeconds: parsed.POLARIS_RABBITMQ_HEARTBEAT_SECONDS,
      connectionTimeoutMs: parsed.POLARIS_RABBITMQ_CONNECTION_TIMEOUT_MS,
      partitions: parsed.POLARIS_RABBITMQ_PARTITIONS,
      partitionOverrides: parsed.POLARIS_RABBITMQ_PARTITION_OVERRIDES,
      assignedPartitions: parsed.POLARIS_RABBITMQ_ASSIGNED_PARTITIONS,
      prefetch: parsed.POLARIS_RABBITMQ_PREFETCH,
      checkpointIntervalMs: parsed.POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS,
      checkpointEvery: parsed.POLARIS_RABBITMQ_CHECKPOINT_EVERY,
      streamRetentionDays: parsed.POLARIS_RABBITMQ_STREAM_RETENTION_DAYS,
    }),
  );

export interface RabbitmqConfig {
  /** AMQP connection URL, credentials included. */
  readonly url: string;
  /** HTTP management API base URL. Provisioning/ops tooling only. */
  readonly managementUrl: string | undefined;
  /** Connection name shown in the management UI. */
  readonly clientId: string;
  readonly tls: boolean;
  readonly heartbeatSeconds: number;
  readonly connectionTimeoutMs: number;
  /** Default super-stream width. */
  readonly partitions: number;
  /** Per-family width overrides, e.g. `{ "raw.events": 6 }`. */
  readonly partitionOverrides: Readonly<Record<string, number>>;
  /** Static partition assignment for this instance. Empty = own everything. */
  readonly assignedPartitions: ReadonlyArray<number>;
  readonly prefetch: number;
  readonly checkpointIntervalMs: number;
  readonly checkpointEvery: number;
  readonly streamRetentionDays: number;
}

/**
 * Resolve the super-stream width for a family: the override when present,
 * the global default otherwise. Dedicated per-project families
 * (`raw.events.<project_id>`) inherit their parent family's width unless
 * they carry their own override, so an isolated project keeps the same
 * ordering guarantees as the shared stream it graduated from.
 */
export function partitionsForFamily(config: RabbitmqConfig, family: string): number {
  const direct = config.partitionOverrides[family];
  if (direct !== undefined) return direct;
  for (const [candidate, count] of Object.entries(config.partitionOverrides)) {
    if (family.startsWith(`${candidate}.`)) return count;
  }
  return config.partitions;
}

export const rabbitmqEnvKeys = [
  "POLARIS_RABBITMQ_URL",
  "POLARIS_RABBITMQ_MANAGEMENT_URL",
  "POLARIS_RABBITMQ_CLIENT_ID",
  "POLARIS_RABBITMQ_TLS",
  "POLARIS_RABBITMQ_HEARTBEAT_SECONDS",
  "POLARIS_RABBITMQ_CONNECTION_TIMEOUT_MS",
  "POLARIS_RABBITMQ_PARTITIONS",
  "POLARIS_RABBITMQ_PARTITION_OVERRIDES",
  "POLARIS_RABBITMQ_ASSIGNED_PARTITIONS",
  "POLARIS_RABBITMQ_PREFETCH",
  "POLARIS_RABBITMQ_CHECKPOINT_INTERVAL_MS",
  "POLARIS_RABBITMQ_CHECKPOINT_EVERY",
  "POLARIS_RABBITMQ_STREAM_RETENTION_DAYS",
] as const;
