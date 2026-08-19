# Polaris

Polaris is an internal multi-project event infrastructure platform. It is the
event backbone for attribution, analytics, activation, and operational
intelligence inside one organisation.

Polaris is the platform. **RabbitMQ is the streaming backbone** Polaris is
built around — not the other way around.

## Core architecture

```text
SDKs / producers
  -> Fastify ingester (apps/ingester-api)
  -> RabbitMQ raw.events
  -> sync/identity/resolver      -> identified.events
  -> sync/enrichment/runtime     -> resolved.events   (traits + geo, in the envelope)
  -> sync/destinations/<vendor>  -> vendor APIs
     async/* reads resolved.events alongside: sessionizer, attribution-engine,
     journey orchestrator, clickhouse-sink -> analytics_raw -> projection tables
```

The full path is documented in
[`docs/architecture/00-overview.md`](docs/architecture/00-overview.md). The
non-negotiable rules (immutable raw events, file-heavy semantic truth, ingress
stays thin, clickhouse-sink feeds from `resolved.events`, ...) are listed
in [`docs/README.md`](docs/README.md).

## Getting started

Day-one onboarding lives in
[`docs/development/getting-started.md`](docs/development/getting-started.md).
That runbook covers prerequisites, first-time setup, daily workflow, common
tasks (issuing keys, syncing the catalog, querying ClickHouse), the
versioned-processor workflow, and troubleshooting.

The two-minute version:

```bash
pnpm install
docker compose up -d --wait
pnpm db:migrate
pnpm clickhouse:bootstrap-local
```

Then start the ingester and exercise it:

```bash
POLARIS_HTTP_PORT=8080 pnpm --filter @polaris/ingester-api run start
# in another shell:
pnpm smoke:vertical-slice
```

## Documentation map

| Surface                                                                                | When to read it                                                                  |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Documentation index](docs/README.md)                                                  | The reading order for architecture docs, ADRs, and implementation playbook.       |
| [Getting started](docs/development/getting-started.md)                                 | You just cloned the repo. Start here.                                            |
| [SDK Handbook](docs/sdk/README.md)                                                     | You're integrating `@polaris/web-sdk` or `@polaris/node-sdk` into a producer.    |
| [Blueprints](blueprints/README.md)                                                     | You want a runnable Next.js app to copy: browser, relayed, and backend ingest.   |
| [API Docs](docs/api/README.md)                                                         | You need the ingester's OpenAPI document, request/response shapes, or error codes. |
| [Audit and Export](docs/development/audit-and-export.md)                               | You need to inspect or bulk-export operational state via the `polaris` CLI.       |
| [CI](docs/development/ci.md)                                                           | You want to know what gates run on every PR and how to opt into integration runs. |
| [Vertical-Slice Smoke](docs/implementation/runbooks/vertical-slice-smoke.md)           | You're touching the ingester, either spine stage, or ClickHouse DDL.             |
| [Delivery roadmap](docs/implementation/delivery-roadmap.md)                            | You're picking up or coordinating work.                                          |
| [Claude Instructions](docs/instructions/claude.md)                                     | You're a contributor (human or agent). Read this before changing code.            |

## License

Internal. Not for external distribution.
