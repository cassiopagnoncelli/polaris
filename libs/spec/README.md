# @polaris/spec

Canonical Polaris event envelope, per-event Zod property schemas, and the
file-backed event catalog loader.

This package is the single source of truth for what a well-formed Polaris
event looks like. The ingester uses it to validate batches; processors
and consumers use it to assert the shape of events they consume.

## What lives here

```text
src/envelope/                 canonical envelope + producer-side envelope
src/events/<domain>/<event>.v<N>.ts
                              per-event Zod property schemas (one per version)
src/catalog/                  YAML loader, binding registry, validator helper
src/reason-codes.ts           ingester batch-response reason codes
test/                         fixtures + Vitest suite
```

The YAML files under the repo-root `definitions/events/**` carry lifecycle
metadata (`lifecycle: active | deprecated`, `sunset_at`) and human
documentation. The Zod schemas in this package carry the semantic
contract. The loader merges the two.

## Schema evolution

`schema_version` is a per-event integer. Multiple versions coexist in
the catalog. v1 (deprecated) and v2 (active) of `page.viewed` ship with
this package as the canonical coexistence example.

Old versions stay registered with `lifecycle: deprecated` and a
`sunset_at` date until after sunset, when the ingester returns reason
code `schema_version_sunset`. See
`docs/architecture/01-event-contract.md` for the full evolution rules.

## SDK boundary

Per `docs/architecture/10-sdk-standards.md`, SDK distributions must not
bundle the event catalog. SDKs import the envelope; the ingester loads
the catalog.

## Adding a new event

1. Create `src/events/<domain>/<event>.v1.ts` exporting a Zod schema.
2. Add a binding in `src/catalog/bindings.ts`.
3. Add `definitions/events/<domain>/<event>.v1.yaml` with lifecycle metadata.
4. Add fixtures + tests under `test/`.

## Adding a new version of an existing event

1. Create `src/events/<domain>/<event>.v<N>.ts`.
2. Register the new binding in `src/catalog/bindings.ts`.
3. Add `definitions/events/<domain>/<event>.v<N>.yaml` with
   `lifecycle: active`.
4. Mark the previous YAML `lifecycle: deprecated` and set `sunset_at`.
5. Update fixtures + tests.

## Checks

```bash
pnpm --filter @polaris/spec typecheck
pnpm --filter @polaris/spec lint
pnpm --filter @polaris/spec test
pnpm --filter @polaris/spec build
```
