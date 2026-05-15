# Phase 1 — Request or create a project and source

Polaris is multi-project. Every event carries a `project_id` and a
`source_id`. Both are *file-backed declarations* under `catalog/`, then
materialized into PostgreSQL by `polaris projects sync` and `polaris sources
sync`. PostgreSQL is the runtime; the catalog is the source of semantic
truth.

> Why two layers? See [Control Plane / Design Position](../architecture/02-control-plane.md#design-position). Short
> version: declarations live in code so they survive cleanly across
> environments and rollbacks; PostgreSQL is just the materialized runtime
> view.

## Who does this

- **Team** drafts the `catalog/projects/` and `catalog/sources/` YAML in
  a PR. The schema reviewer signs off.
- **Operator** merges the PR, then runs `polaris projects sync` and
  `polaris sources sync` against each target environment.

A team **cannot** self-serve `polaris ... sync` against production:
`projects.sync` and `sources.sync` are marked `mutates: true`, so the
production gate from [Control Plane / Operator
Identity](../architecture/02-control-plane.md#operator-identity-and-audit-actor)
demands an authenticated operator token. Development and staging are
friction-free; production requires the operator.

## Step 1.1 — Declare the project

Create `catalog/projects/<project_id>.yaml`. The shape:

```yaml
# Catalog entry: project `your_project`.
project_id: your_project
display_name: Your Project
owner: your-team
description: >-
  Short one-paragraph summary of what this project is about and who runs it.
status: active
```

Real example (`catalog/projects/storefront.yaml`):

```yaml
project_id: storefront
display_name: Storefront
owner: storefront-platform
description: >-
  Customer-facing storefront across web, mobile, and backend services.
status: active
```

## Step 1.2 — Declare each source

Sources are the producers within your project. A typical project has at least
one `web` source (the browser) and one `backend` source (an API), but you can
have as many as you need (mobile, webhook relays, ETL jobs, etc.).

Each source goes at
`catalog/sources/<project_id>/<source_id>.yaml`. The shape:

```yaml
project_id: your_project
source_id: your-project-web
source_type: web
owner: your-team
description: >-
  Browser SDK calls from the public site. Publishable write key, origin
  checked, rate limited.
runtime: active
allowed_environments:
  - development
  - staging
  - production
status: active
```

Supported `source_type` values are `web`, `backend`, `mobile`, `webhook`,
and `job` (see `apps/polaris-cli/src/commands/keys/create.ts`).

## Step 1.3 — Inspect what you declared

```bash
# Read your declaration straight off disk (no DB needed):
polaris projects list --from-catalog
polaris sources list --from-catalog --project your_project
polaris projects show your_project --from-catalog
polaris sources show your-project-web --from-catalog --project your_project
```

`--from-catalog` reads `catalog/` directly — useful on a fresh laptop before
any sync has happened, and useful during a PR review.

## Step 1.4 — Apply with `sync` (operator)

The operator runs each sync as a dry-run first, then for real:

```bash
# Operator, dev or staging — no gate fires.
polaris projects sync --dry-run
polaris projects sync

polaris sources sync --dry-run
polaris sources sync
```

Both commands diff the catalog against PostgreSQL and emit:

```text
projects sync applied: +1 ~0 =3
  + your_project
sources sync applied: +1 ~0 =5
  + your_project/your-project-web
```

Production requires `POLARIS_TOKEN` and the dispatcher's audit gate.
Production sync also writes an `audit_records` row in the same transaction
as the INSERT (no audit, no INSERT).

> **Catalog absence is not a delete signal in v1.** Removing a project
> or source from `catalog/` does *not* delete the PostgreSQL row. Deletion is
> a separate workflow because it would cascade through every FK that
> references the row. See the source comments in
> `apps/polaris-cli/src/commands/projects/sync.ts` and `sources/sync.ts`.

## Step 1.5 — Confirm the runtime row exists

```bash
# After the operator runs sync against your environment:
polaris projects show your_project
polaris sources list --project your_project
```

Without `--from-catalog`, both commands read PostgreSQL. If the row is
missing you get a `not present in PostgreSQL. Run \`polaris projects sync\`
first.` error — that means the operator has not synced this environment yet.

## Done when

- `polaris projects show your_project` (no `--from-catalog`) prints your
  row in every environment you will produce events from.
- `polaris sources list --project your_project` lists each declared
  source with `status=active` and the environments you need under
  `allowed_environments`.

## Next

[Phase 2 — Create frontend and backend API keys](./02-api-keys.md).
