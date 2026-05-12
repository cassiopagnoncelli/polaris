import { z } from "zod";
import {
  booleanFromStringSchema,
  csvListSchema,
  durationMsSchema,
  nonEmptyStringSchema,
} from "./common.js";

/**
 * Redpanda / Kafka client config.
 *
 * Polaris services talk to Redpanda through the (forthcoming) shared-kafka
 * package. This schema produces the values that wrapper needs and nothing
 * more — `shared-kafka` itself owns producer/consumer tuning defaults.
 *
 * Env vars:
 *
 *   POLARIS_REDPANDA_BROKERS         required — comma-separated host:port list
 *   POLARIS_REDPANDA_CLIENT_ID       required — KafkaJS client id (defaults to the
 *                                    service name once it is known)
 *   POLARIS_REDPANDA_SSL             (false)
 *   POLARIS_REDPANDA_SASL_MECHANISM  (optional) — plain | scram-sha-256 | scram-sha-512
 *   POLARIS_REDPANDA_SASL_USERNAME   (required if SASL mechanism is set)
 *   POLARIS_REDPANDA_SASL_PASSWORD   (required if SASL mechanism is set)
 *   POLARIS_REDPANDA_CONNECTION_TIMEOUT_MS (10000)
 *   POLARIS_REDPANDA_REQUEST_TIMEOUT_MS    (30000)
 */
export const saslMechanismSchema = z.enum(["plain", "scram-sha-256", "scram-sha-512"]);

export type SaslMechanism = z.infer<typeof saslMechanismSchema>;

export const redpandaEnvSchema = z
  .object({
    POLARIS_REDPANDA_BROKERS: csvListSchema.pipe(
      z
        .array(nonEmptyStringSchema)
        .min(1, "POLARIS_REDPANDA_BROKERS must contain at least one host:port entry"),
    ),
    POLARIS_REDPANDA_CLIENT_ID: nonEmptyStringSchema,
    POLARIS_REDPANDA_SSL: booleanFromStringSchema.default(false),
    POLARIS_REDPANDA_SASL_MECHANISM: saslMechanismSchema.optional(),
    POLARIS_REDPANDA_SASL_USERNAME: nonEmptyStringSchema.optional(),
    POLARIS_REDPANDA_SASL_PASSWORD: nonEmptyStringSchema.optional(),
    POLARIS_REDPANDA_CONNECTION_TIMEOUT_MS: durationMsSchema.default(10_000),
    POLARIS_REDPANDA_REQUEST_TIMEOUT_MS: durationMsSchema.default(30_000),
  })
  .superRefine((parsed, ctx) => {
    const hasMechanism = parsed.POLARIS_REDPANDA_SASL_MECHANISM !== undefined;
    if (hasMechanism) {
      if (parsed.POLARIS_REDPANDA_SASL_USERNAME === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["POLARIS_REDPANDA_SASL_USERNAME"],
          message: "SASL username is required when POLARIS_REDPANDA_SASL_MECHANISM is set",
        });
      }
      if (parsed.POLARIS_REDPANDA_SASL_PASSWORD === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["POLARIS_REDPANDA_SASL_PASSWORD"],
          message: "SASL password is required when POLARIS_REDPANDA_SASL_MECHANISM is set",
        });
      }
    }
  })
  .transform((parsed): RedpandaConfig => {
    const sasl =
      parsed.POLARIS_REDPANDA_SASL_MECHANISM !== undefined &&
      parsed.POLARIS_REDPANDA_SASL_USERNAME !== undefined &&
      parsed.POLARIS_REDPANDA_SASL_PASSWORD !== undefined
        ? ({
            mechanism: parsed.POLARIS_REDPANDA_SASL_MECHANISM,
            username: parsed.POLARIS_REDPANDA_SASL_USERNAME,
            password: parsed.POLARIS_REDPANDA_SASL_PASSWORD,
          } as const)
        : undefined;
    return {
      brokers: parsed.POLARIS_REDPANDA_BROKERS,
      clientId: parsed.POLARIS_REDPANDA_CLIENT_ID,
      ssl: parsed.POLARIS_REDPANDA_SSL,
      sasl,
      connectionTimeoutMs: parsed.POLARIS_REDPANDA_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: parsed.POLARIS_REDPANDA_REQUEST_TIMEOUT_MS,
    };
  });

export interface RedpandaSaslConfig {
  readonly mechanism: SaslMechanism;
  readonly username: string;
  readonly password: string;
}

export interface RedpandaConfig {
  readonly brokers: ReadonlyArray<string>;
  readonly clientId: string;
  readonly ssl: boolean;
  readonly sasl: RedpandaSaslConfig | undefined;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export const redpandaEnvKeys = [
  "POLARIS_REDPANDA_BROKERS",
  "POLARIS_REDPANDA_CLIENT_ID",
  "POLARIS_REDPANDA_SSL",
  "POLARIS_REDPANDA_SASL_MECHANISM",
  "POLARIS_REDPANDA_SASL_USERNAME",
  "POLARIS_REDPANDA_SASL_PASSWORD",
  "POLARIS_REDPANDA_CONNECTION_TIMEOUT_MS",
  "POLARIS_REDPANDA_REQUEST_TIMEOUT_MS",
] as const;
