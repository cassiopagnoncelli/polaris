/**
 * Control-plane API runtime config.
 *
 * Composes shared schema fragments (service / http / postgres) plus a
 * tiny per-service block. The service has no RabbitMQ or Redis
 * dependency in v1 (P6-000 ships the shell + auth/gate/whoami; business
 * endpoints land later).
 */
import {
  composeConfigSchema,
  type HttpConfig,
  httpEnvSchema,
  loadConfigWithDefaults,
  type PostgresConfig,
  postgresEnvSchema,
  type ServiceConfig,
  serviceEnvSchema,
} from "@polaris/shared-config";

import { type AdminConfig, adminEnvSchema } from "./admin/config.js";

export const CONTROL_PLANE_SERVICE_NAME = "control-plane-api" as const;

export interface ControlPlaneConfig {
  readonly service: ServiceConfig;
  readonly http: HttpConfig;
  readonly postgres: PostgresConfig;
  /**
   * Admin UI block, or `null` when `POLARIS_ADMIN_UI_ENABLED` is off (the
   * default). Null means the plugin is never registered, so `/admin/*` does
   * not exist rather than existing and refusing.
   */
  readonly admin: AdminConfig | null;
}

export function controlPlaneConfigSchema() {
  return composeConfigSchema({
    service: serviceEnvSchema,
    http: httpEnvSchema,
    postgres: postgresEnvSchema,
    admin: adminEnvSchema,
  });
}

export function loadControlPlaneConfig(): ControlPlaneConfig {
  return loadConfigWithDefaults({
    serviceName: CONTROL_PLANE_SERVICE_NAME,
    schema: controlPlaneConfigSchema(),
  });
}
