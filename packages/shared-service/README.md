# @polaris/shared-service-bootstrap

Thin Fastify service bootstrap for Polaris services. Composes
`@polaris/shared-config` for runtime configuration and `@polaris/shared-logger`
for Pino-based JSON logging, and adds the standard request-ID,
RFC 7807 Problem Details, health/ready/metrics, OpenAPI, and graceful
shutdown wiring.

## What this package owns

- `bootstrapService({ info, ... })` — one-shot factory that returns a
  configured Fastify instance, a logger bound to the service identity, and
  a `shutdown(signal)` trigger.
- `ProblemError` and `createProblem` — RFC 7807 helpers used by route
  handlers to throw HTTP failures with stable `code` + `request_id`
  fields.
- Per-request UUIDv7 IDs read from `x-polaris-request-id` / `x-request-id`
  headers and echoed back to the client on every response.
- Pluggable readiness probes for `/ready`.
- `/metrics` Prometheus text route (empty body stub; concrete producer is
  plugged in by P10 metrics work).
- OpenAPI integration hook for Fastify + Zod route schemas.
- Graceful shutdown handlers for `SIGTERM` / `SIGINT` with bounded
  drain timeout.

## Quick start

```ts
import { loadConfigWithDefaults, composeConfigSchema, serviceEnvSchema, httpEnvSchema } from "@polaris/shared-config";
import { bootstrapService, ProblemError } from "@polaris/shared-service-bootstrap";

const schema = composeConfigSchema({
  service: serviceEnvSchema,
  http: httpEnvSchema,
});

const config = loadConfigWithDefaults({
  serviceName: "ingester-api",
  schema,
});

const { app, logger, shutdown } = await bootstrapService({
  info: {
    serviceName: config.service.serviceName,
    serviceVersion: config.service.serviceVersion,
    environment: config.service.environment,
    gitSha: config.service.gitSha,
    buildTime: config.service.buildTime,
  },
  readinessProbes: [
    async function postgres(_app) {
      // ping the pool, return up/down
      return { name: "postgres", status: "up" };
    },
  ],
  shutdownTasks: [
    async () => {
      // close kafka producer, pg pool, redis client, clickhouse client
    },
  ],
});

app.post("/v1/events", async (request, reply) => {
  if (!request.headers["x-polaris-api-key"]) {
    throw new ProblemError({
      status: 401,
      code: "missing_api_key",
      detail: "Send the API key in the `x-polaris-api-key` header.",
    });
  }
  // ...
  return { accepted: [], rejected: [] };
});

await app.listen({ host: config.http.host, port: config.http.port });
logger.info({ port: config.http.port }, "service listening");
```

## Defaults and conventions

| Concern             | Default                                       |
| ------------------- | --------------------------------------------- |
| Health path         | `/health`                                     |
| Readiness path      | `/ready`                                      |
| Metrics path        | `/metrics`                                    |
| Problem MIME        | `application/problem+json`                    |
| Problem type base   | `https://docs.polaris/errors/`                |
| Request ID header   | `x-polaris-request-id` (also `x-request-id`)  |
| Request ID echo     | `x-request-id` response header                |
| Shutdown signals    | `SIGTERM`, `SIGINT`                           |
| Shutdown timeout    | 25 000 ms                                     |
| Request logging     | suppressed by default (services log per-route)|

The bootstrap intentionally stays thin (per
[Engineering Standards — Fastify Service Structure](../../docs/architecture/09-engineering-standards.md)).
Route definitions, business logic, and validation schemas remain in each
service.

## Problem Details

Polaris uses RFC 7807 `application/problem+json` for request-level HTTP
failures. Every body includes a stable `code` and the per-request
`request_id`:

```json
{
  "type": "https://docs.polaris/errors/invalid_api_key",
  "title": "Invalid API key",
  "status": 401,
  "code": "invalid_api_key",
  "detail": "The provided API key is invalid or revoked.",
  "request_id": "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551"
}
```

Route handlers throw `ProblemError` to surface a problem; the bootstrap
error handler attaches the `request_id` from the Fastify request scope and
emits the response. Fastify validation failures map to
`400 invalid_request` with the validation issues attached as an extension
member. Unhandled errors map to `500 internal_error` and log at `error`
level for operator triage — the `detail` field is intentionally omitted
so internal error messages never leak to clients.

For per-event ingestion failures (per-event reason codes inside a batch
response), see `packages/shared-schemas/`.

## Readiness probes

`/ready` aggregates an array of async probes. Each probe is passed the
Fastify instance so it can reuse any decorators / clients the service
installed. Probes return `{ name, status, detail?, latencyMs? }`. A
throwing probe is caught and recorded as `status: "down"`.

By default a probe reporting `"degraded"` rolls up to a 503 — services
that want to keep serving traffic during partial outages can set
`health.degradedIsNotReady: false`.

## Metrics

The `/metrics` route is a placeholder that returns an empty body when no
producer is configured, with the Prometheus text content type already in
place. P10 (Metrics Standardisation) plugs in the concrete `prom-client`
registry; services pass `metrics: { producer: () => register.metrics() }`
to wire it up.

## OpenAPI

`bootstrapService` accepts an `openapi.setup` hook that runs after the
shared routes are registered. Services using `@fastify/swagger` +
`fastify-type-provider-zod` plug their setup function in here; the
bootstrap stays free of OpenAPI-specific dependencies so it can be reused
by services without HTTP-route schemas (e.g. internal admin tools).

## Graceful shutdown

By default the bootstrap installs handlers for `SIGTERM` and `SIGINT`. On
signal, it:

1. Closes the Fastify server so no new connections are accepted.
2. Runs each registered `shutdownTask` in order, awaiting each one.
3. Exits with code `0`, or `1` if the bounded timeout fires first.

Task errors are logged but do not abort the remaining shutdown — partial
cleanup is better than no cleanup.

## Scripts

- `pnpm --filter @polaris/shared-service-bootstrap build` — emit `dist/`
- `pnpm --filter @polaris/shared-service-bootstrap typecheck` — strict TypeScript
- `pnpm --filter @polaris/shared-service-bootstrap lint` — Biome
- `pnpm --filter @polaris/shared-service-bootstrap test` — Vitest

## References

- [Engineering Standards — Fastify Service Structure](../../docs/architecture/09-engineering-standards.md)
- [Engineering Standards — HTTP Error Contract](../../docs/architecture/09-engineering-standards.md)
- [Observability and Operations — Service Contract](../../docs/architecture/08-observability-and-operations.md)
- [Ingestion and SDKs](../../docs/architecture/04-ingestion-and-sdks.md)
