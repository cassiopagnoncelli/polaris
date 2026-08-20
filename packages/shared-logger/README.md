# @polaris/shared-logger

Pino-based structured logger for Polaris services. Polaris services depend on
this package and never import `pino` directly so the upstream version,
redaction defaults, and standard log-field shape stay coordinated.

## What this package owns

- JSON-only logger factory (`createLogger`) with service-binding metadata
  (`service`, `version`, `env`, `region`, `hostname`).
- Baked-in redaction for secrets, authorization headers, cookies, tokens,
  card data, passwords, and raw event payloads. The list is in
  `src/redaction.ts` and is exported as `DEFAULT_REDACTION_PATHS`.
- Typed child-logger helpers for the standard Polaris scopes
  (`withRequest`, `withSource`, `withProcessor`, `withConsumer`, `withReplay`,
  `withMessage`).
- `StandardLogFields` types matching
  [`docs/architecture/08-observability-and-operations.md`](../../docs/architecture/08-observability-and-operations.md)
  "Standard Log Fields".

## Quick start

```ts
import { createLogger, withRequest, withProcessor } from "@polaris/shared-logger";

const log = createLogger({
  service: "ingester-api",
  version: process.env.POLARIS_BUILD_VERSION,
  env: process.env.POLARIS_ENV ?? "local",
});

// Per-request scope, attached on Fastify's `onRequest` hook
const reqLog = log.child(
  withRequest({
    request_id: req.id,
    project_id: req.project_id,
    environment: req.environment,
    source_id: req.source_id,
  }),
);
reqLog.info({ event_id: "018f-..." }, "event accepted");

// Processor scope, applied at run boot
const procLog = log.child(
  withProcessor({
    processor_name: "sessionizer",
    processor_version: "v1",
    topic: "raw.events",
    partition: 7,
  }),
);
procLog.info("processor run starting");
```

Child loggers compose. Stack `withRequest`, `withProcessor`, and `withMessage`
on the same chain to attach request, processor, and per-message
identifiers without rebuilding the binding object at every call site.

## Redaction guarantees

Logger redaction is the **second** line of defense after the ingester's
forbidden-field policy (`libs/governance/`). The policy evaluator
applies redact/reject before any log line is emitted; this package then
prevents accidental leakage of well-known sensitive field names that may
still appear inside log bindings.

The default list (see `src/redaction.ts`) covers:

- passwords (`password`, `passwd`, `pwd`)
- authorization headers (`authorization`, `proxy-authorization`, `x-api-key`,
  `x-polaris-api-key`) on bare `headers`, `req.headers`, and
  `request.headers` shapes
- cookies (`cookie`, `set-cookie`, `session_cookie`) at top level and inside
  `req.headers` / `res.headers`
- tokens (`token`, `access_token`, `refresh_token`, `id_token`,
  `bearer_token`, `client_secret`, `api_key`, `api_secret`)
- private keys (`private_key`, `priv_key`)
- card data (`cvv`, `cvc`, `card_security_code`, `card_number`,
  `card_number_full`, `pan`) at top level, under `properties.*`, and on
  generic wildcard paths
- raw event payloads (`event.properties`, `events[*].properties`,
  `raw.properties`, `envelope.properties`)

Per the engineering standards, **raw event payloads are not logged by
default**. Operators who genuinely need a full payload at debug level must
build a dedicated child logger that strips the relevant path and gate the
call behind an environment-aware feature flag.

Callers can **extend** the list (never narrow it) via
`createLogger({ additionalRedactionPaths: [...] })` — e.g. project-specific
context keys, vendor-credential paths in destination consumers.

## Standard log fields

Logs include stable identifiers where applicable:

| Field                | Source                                          |
| -------------------- | ----------------------------------------------- |
| `event_id`           | canonical envelope; UUIDv7                      |
| `project_id`         | stamped from API key                            |
| `environment`        | stamped from API key                            |
| `source_id`          | trusted source metadata                         |
| `topic`              | Concrete partition stream                       |
| `partition`          | Partition index within the super stream         |
| `offset`             | Stream offset                         |
| `processor_name`     | processor immutable directory                   |
| `processor_version`  | processor immutable version directory (`v1`...) |
| `consumer_name`      | destination consumer name                       |
| `consumer_version`   | destination consumer immutable version          |
| `replay_job_id`      | replay job UUIDv7                               |
| `destination_id`     | runtime destination instance                    |
| `request_id`         | per-request UUIDv7                              |

## Scripts

- `pnpm --filter @polaris/shared-logger build` — emit `dist/`
- `pnpm --filter @polaris/shared-logger typecheck` — strict TypeScript
- `pnpm --filter @polaris/shared-logger lint` — Biome
- `pnpm --filter @polaris/shared-logger test` — Vitest

## References

- [Engineering Standards — Logging](../../docs/architecture/09-engineering-standards.md)
- [Observability and Operations — Standard Log Fields](../../docs/architecture/08-observability-and-operations.md)
- [Event Contract — Forbidden-Field Policy](../../docs/architecture/01-event-contract.md)
