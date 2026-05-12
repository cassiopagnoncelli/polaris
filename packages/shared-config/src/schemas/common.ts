import { z } from "zod";

/**
 * Polaris deployment environments. Producers never send `environment`; the
 * ingester stamps it from the API key. Services receive it through config so
 * logs, metrics, and dashboards can label runtime correctly.
 *
 * The `local` variant is included so developer machines and CI runs have a
 * truthful value to emit; it must never appear on a real deployed instance.
 */
export const environmentSchema = z.enum(["local", "development", "staging", "production"]);

export type Environment = z.infer<typeof environmentSchema>;

/**
 * Pino-compatible log levels.
 */
export const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

export type LogLevel = z.infer<typeof logLevelSchema>;

/**
 * Strict positive integer port suitable for HTTP/Kafka/Postgres listeners.
 *
 * Coerces from string because env vars are always strings. The lower bound is
 * 1 (port 0 is "any free port", which is fine for tests but should never be
 * baked into config; tests should pass it explicitly). The upper bound is the
 * standard 16-bit port maximum.
 */
export const portSchema = z.coerce
  .number()
  .int()
  .min(1, "port must be between 1 and 65535")
  .max(65535, "port must be between 1 and 65535");

/**
 * Boolean that accepts the strings real configs actually produce.
 *
 * Accepts: `true`, `false`, `1`, `0`, `yes`, `no`, `on`, `off`. Case
 * insensitive. Anything else fails so typos like `Tru` blow up at startup.
 */
export const booleanFromStringSchema = z
  .union([z.boolean(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "boolean") return value;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    ctx.addIssue({
      code: "custom",
      message: `expected boolean-like string (true/false/1/0/yes/no/on/off), got "${value}"`,
    });
    return z.NEVER;
  });

/**
 * Comma-separated list of strings. Trims each entry and drops empties.
 *
 * Accepts a real array as a passthrough so programmatic callers can hand in
 * an array directly without round-tripping through a string.
 */
export const csvListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value): string[] => {
    if (Array.isArray(value)) {
      return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    }
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  });

/**
 * A non-empty string. Trims surrounding whitespace. Useful for required
 * secrets, hostnames, service names, etc., where an accidentally empty
 * env var should fail loudly rather than masquerade as a present value.
 */
export const nonEmptyStringSchema = z.string().trim().min(1, "must be a non-empty string");

/**
 * Positive integer (>= 1), coerced from string.
 */
export const positiveIntSchema = z.coerce
  .number()
  .int()
  .min(1, "must be a positive integer (>= 1)");

/**
 * Non-negative integer (>= 0), coerced from string.
 */
export const nonNegativeIntSchema = z.coerce
  .number()
  .int()
  .min(0, "must be a non-negative integer (>= 0)");

/**
 * Duration in milliseconds. Accepts a plain number or the integer-string form
 * produced by env vars. Strings without a unit are interpreted as ms.
 */
export const durationMsSchema = z.coerce
  .number()
  .int()
  .min(0, "duration must be a non-negative integer (milliseconds)");
