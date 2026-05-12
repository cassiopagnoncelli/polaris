/**
 * Polaris shared runtime configuration.
 *
 * The architecture rule is short: services must not read `process.env`
 * directly. They build (or compose) a Zod schema for the env vars they need,
 * hand it to `loadConfig` once at startup, and use the typed result. Invalid
 * config throws `ConfigValidationError`, which services must allow to crash
 * the process so deployments fail fast.
 *
 * Typical usage:
 *
 * ```ts
 * import { z } from "zod";
 * import {
 *   loadConfig,
 *   serviceEnvSchema,
 *   postgresEnvSchema,
 *   redpandaEnvSchema,
 * } from "@polaris/shared-config";
 *
 * const schema = z
 *   .object({
 *     service: serviceEnvSchema,
 *     postgres: postgresEnvSchema,
 *     redpanda: redpandaEnvSchema,
 *   })
 *   .transform((parsed) => ({
 *     service: parsed.service,
 *     postgres: parsed.postgres,
 *     redpanda: parsed.redpanda,
 *   }));
 *
 * const config = loadConfig({
 *   serviceName: "ingester-api",
 *   schema,
 *   files: [".env.local", ".env"],
 * });
 * ```
 *
 * Each `*EnvSchema` parses an env-shaped object (uppercase string keys) and
 * transforms it into a typed sub-config. The schemas are intentionally
 * composable: services can also pass the entire env source to a flat
 * `z.object({...})` if they prefer a single namespace.
 *
 * Semantic config (event schemas, destination mappings, processor logic,
 * forbidden-field policy, ClickHouse DDL, etc.) does NOT belong here. It
 * lives in versioned files and code per the architecture docs.
 */

export * from "./errors.js";
export * from "./env.js";
export * from "./loader.js";
export * from "./schemas/index.js";
