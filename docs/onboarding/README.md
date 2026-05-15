# Polaris Internal Onboarding Guide

This is the cold-start runbook for a project team adopting Polaris. Follow the
phases in order; each one ends with a verifiable check before you move on.

If you are an *operator* (issuing keys, creating destinations, running replays
against production) you also need [Getting Started](../development/getting-started.md)
and [Audit and Export](../development/audit-and-export.md). This guide assumes
the operator is on the other end of the email/chat — your team is consuming
Polaris, not running it.

## What you get when you finish

- A Polaris **project** + **source** declared in the catalog and materialized
  in PostgreSQL.
- **Frontend** and/or **backend API keys** bound to your `(project,
  environment, source)` tuple.
- One **registered event name** with a Zod schema in the catalog.
- A producer (Web or Node SDK) calling `track()` against the ingester.
- A confirmed first event visible via `polaris audit` /
  `polaris export` and through the analytics surface.
- *(Optional)* A **destination instance** wired by the operator so your events
  flow to a vendor (Meta CAPI, GA4, TikTok, Braze, etc.).

## Happy-path checklist

| Step | Owner | Output |
|------|-------|--------|
| 1. Declare a project + source in `catalog/` | team + operator | `catalog/projects/<id>.yaml`, `catalog/sources/<id>/<source>.yaml`, `polaris projects sync` and `polaris sources sync` applied |
| 2. Operator issues your API keys | operator | one frontend key + one backend key returned by `polaris keys create`, handed to your team out-of-band |
| 3. Pick event names and add schemas | team + schema reviewer | `catalog/events/<domain>/<event>.v1.yaml` + `packages/shared-schemas/src/events/<domain>/<event>.v1.ts` |
| 4. Install the Web SDK (if you have a browser surface) | team | `@polaris/web-sdk` initialized with your frontend key |
| 5. Install the Node SDK (if you have a backend surface) | team | `@polaris/node-sdk` initialized with your backend key |
| 6. Send your first event + verify ingestion | team | event visible in `polaris audit` / `polaris export audit` |
| 7. View it in analytics | team | row visible via `shared-clickhouse` projection helpers or ad-hoc `clickhouse-client` |
| 8. Request destination enablement | team -> operator | `polaris destinations create ...` lands a row; operator hands you the `destination_id` |
| 9. Wire support + escalation | team | DLQ runbook bookmarked, on-call alias known |

## Section-by-section table of contents

1. [Request or create a project and source](./01-projects-and-sources.md)
2. [Create frontend and backend API keys](./02-api-keys.md)
3. [Pick event names and add a schema](./03-event-names-and-schemas.md)
4. [Install the Web SDK](./04-install-web-sdk.md)
5. [Install the Node SDK](./05-install-node-sdk.md)
6. [Send your first event and verify ingestion](./06-first-event.md)
7. [View it in analytics](./07-analytics.md)
8. [Request destination enablement](./08-destinations.md)
9. [Support and escalation path](./09-support-and-escalation.md)
10. [Troubleshooting](./10-troubleshooting.md)

## Where this fits with the rest of the docs

- [Architecture reading order](../README.md) — read this if you want the
  *why* behind any of the rules below.
- [SDK Handbook](../sdk/README.md) — full reference for `@polaris/web-sdk`
  and `@polaris/node-sdk`. This guide quotes the minimum needed; the
  handbook is authoritative.
- [API Docs](../api/README.md) — OpenAPI document for the ingester. The
  ingester is the only HTTP surface in v1.
- [Audit and Export](../development/audit-and-export.md) — operator-level
  reference for the audit/export commands you will see in
  [Phase 6](./06-first-event.md).
- [Destination DLQ Triage](../operations/destination-dlq-triage.md) —
  the runbook on-call follows when your destination pipeline fails;
  referenced from [Phase 9](./09-support-and-escalation.md).

## Conventions in this guide

- Every CLI command, package name, and API endpoint is real and verified
  against the source. If you find a drift, open a docs PR rather than
  working around it.
- "Team" means your project's engineers. "Operator" means the Polaris
  platform engineer with a `POLARIS_TOKEN`. Some commands require an
  authenticated operator against production; the gate is documented in
  [Control Plane / Operator Identity](../architecture/02-control-plane.md#operator-identity-and-audit-actor).
- All examples assume `development` is your sandbox. Swap `--env
  development` for `--env staging` or `--env production` when promoting.
