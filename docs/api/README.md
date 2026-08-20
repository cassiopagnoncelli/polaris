# Polaris API Documentation

Polaris ships one HTTP service in v1: the **ingester**. This directory holds the published OpenAPI document for the ingester, plus operator pointers for rendering and consuming it. Control-plane and dashboard APIs will land here as separate documents when those services are built.

## Canonical document

```text
docs/api/openapi.yaml   # source of truth for human review (committed)
docs/api/openapi.json   # same document in JSON (committed, for tools that prefer it)
```

Both files are **generated** from the Zod sources in [`libs/spec`](../../libs/spec/) and the Fastify routes in [`apps/ingester-api`](../../apps/ingester-api/). Do not edit them by hand — changes survive only one regeneration cycle. Edit the Zod sources or the OpenAPI assembly module (`apps/ingester-api/src/openapi/`) instead.

## What the doc covers

- `POST /v1/events` — the only ingestion path. Authentication via `X-Polaris-Api-Key`, batch request body, per-event response with stable reason codes, and RFC 7807 Problem Details for request-level errors.
- `GET /health` — liveness probe. Does not check downstream dependencies.
- `GET /ready` — readiness probe. Aggregates registered probes (PostgreSQL, Redis, RabbitMQ, ...).
- `GET /metrics` — Prometheus text exposition.

## Source pointers

The document is composed in this order:

| Source                                              | Contributes                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `libs/spec/src/envelope/`             | Canonical envelope + producer envelope component schemas.                |
| `libs/spec/src/reason-codes.ts`       | Batch request/response shapes, per-event reason code enums.              |
| `apps/ingester-api/src/openapi/paths.ts`            | Path operations, request/response examples, RFC 7807 error responses.    |
| `apps/ingester-api/src/openapi/document.ts`         | Document assembly, info block, server list, tags.                        |
| `packages/shared-service-bootstrap/src/problem/`    | Common Problem `code` values referenced by error examples.               |
| `apps/ingester-api/src/auth/errors.ts`              | Auth-specific Problem codes (`missing_api_key`, `invalid_api_key`, ...). |

## Regenerating

```bash
pnpm openapi          # write docs/api/openapi.{yaml,json}
pnpm openapi:check    # re-run and fail if the committed file is out of date
```

`pnpm openapi:check` is the gate CI runs. If it fails, the Zod sources changed but the published doc was not regenerated. Re-run `pnpm openapi` and commit the result.

Both commands run `pnpm --filter @polaris/ingester-api run build` first, because the generator imports the compiled ingester package.

## Rendering locally

The committed YAML works with every mainstream OpenAPI renderer. Two options:

**Redocly CLI** (recommended for offline preview):

```bash
npx -y @redocly/cli@latest preview-docs docs/api/openapi.yaml
```

**Swagger UI** via a one-shot container:

```bash
docker run --rm -p 8081:8080 \
  -e SWAGGER_JSON=/spec/openapi.json \
  -v "$PWD/docs/api:/spec" \
  swaggerapi/swagger-ui
```

Either command opens an interactive renderer with the request/response examples, per-error Problem Details bodies, and the partial-acceptance batch flow.

## Live document from a running ingester

A running ingester also serves the same document at runtime so operators can curl it in any environment:

```bash
curl -s http://localhost:4000/openapi.json | jq '.info'
```

The runtime document picks up the binary's version and (where overridden) environment-specific server URLs. CI compares the committed file against a freshly regenerated copy from the source tree — not against a live binary — so the published doc stays deterministic.

## Related references

- [Architecture: Ingestion and SDKs](../architecture/04-ingestion-and-sdks.md) — the canonical contract behind `POST /v1/events`.
- [Architecture: Event Contract](../architecture/01-event-contract.md) — envelope rules, reason codes, forbidden-field policy.
- [Architecture: Engineering Standards](../architecture/09-engineering-standards.md) — OpenAPI generation policy, HTTP error contract.
- [SDK Handbook](../sdk/README.md) — client-side perspective (how SDKs use the response codes documented here).
- [Control Plane](../architecture/02-control-plane.md) — how API keys are issued and bound to project/environment/source.
