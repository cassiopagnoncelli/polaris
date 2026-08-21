# Connectors

The vendor registry. One directory per vendor per version, each holding a
uniform implementation of a port — the vendor's mapping and its delivery, and
nothing else.

```
connectors/
  destinations/{braze,ga4,meta-capi,tiktok,webhook-sink}/v1   # map() + deliver()
  sources/<vendor>/v1                                          # ○ future home
  warehouses/<vendor>/v1                                       # ○ future home
```

`○` marks a home named in [ADR-0007](../docs/adr/0007-restructure-the-repository-around-six-object-kinds.md)
and created in this repository only when its first real file lands. Source and
warehouse connectors arrive with their first vendor; the empty directories are
not committed, because a tree that promises what it does not hold stops being
readable as a ledger.

## The registry rule

**Adding a vendor is a connector entry plus its wiring in `definitions/` and
the project-config registry. It is not a new deployable.**

This is the point of splitting the vendor-facing edge in two. A connector knows
one vendor: how a normalized event becomes that vendor's payload, and how that
payload reaches that vendor's API. A **unit** under `sync/destinations/` knows
one deployment: which broker, which database, which port to listen on. Because
the two are counted separately, `connectors/` records which vendors EXIST while
how many processes serve them stays an operational decision that leaves no
trace in this tree.

Today the five destinations happen to run one deployable each, and ADR-0007
leaves it that way deliberately: pooling them behind a shared delivery engine
(`sync/destinations/delivery/v1`) is an operational decision to be proven when
vendor count demands it, not a shape to adopt in advance. So the honest
statement of the rule is about DEFAULTS and about where the cost lands. A
vendor needs its own process only when somebody decides it does — a noisy
neighbour, a credential blast radius, a scaling profile — and that decision is
then paid for in `libs/bus`'s `POLARIS_COMPONENTS`, `infra/service-ports.json`,
a `Dockerfile` and a unit. None of that is owed by the act of supporting the
vendor, and a sixth connector that skips all of it is not a shortcut.

## What a connector may import

`libs/spec`, its `libs/delivery` port, and third-party packages — the vendor
SDK is the point of the thing. **No other `@polaris/*` package.** This is
ADR-0007's second law and `scripts/lint-import-direction.mjs` fails the build
on a breach.

The rule is not tidiness. A connector that can reach the bus or a Postgres pool
is a connector that can only run where those exist, and the registry's whole
value is that a vendor adapter is cheap to add and cheap to move. The one
carve-out is test files, which the lint skips on purpose: a test reaches across
layers because that is what a test is for, so a connector's `test/` may take a
logger or a bus type as a devDependency.

That law is also why `@polaris/delivery-port` re-declares `positiveIntSchema`
rather than re-exporting `@polaris/runtime-config`'s. The two coerce
identically and answer to different contracts — one parses an environment
variable set once at boot, the other a value an operator stored through the
control plane — and laundering the second through the port would have bought a
forbidden edge nothing needed.

## Naming

`connectors/<family>/<vendor>/<version>` is `@polaris/<family-singular>-<vendor>-<version>`:
`connectors/destinations/ga4/v1` is `@polaris/destination-ga4-v1`. The family is
singular and present because a vendor can appear in more than one of them —
`clickhouse` is a plausible warehouse and a plausible destination, and
`@polaris/connector-clickhouse-v1` could not say which.

The directory name is also the connector's **slug**, the registry key an
operator configures against. It is not always `identity.vendor`: webhook-sink's
vendor is `webhook`, because webhooks belong to no vendor, while it is
registered, queued and configured as `webhook-sink`. The slug is what a person
types; the vendor literal is what gets stamped on a delivery record.

## Adding a vendor, end to end

The worked example is **Klaviyo**, a hypothetical sixth destination. Nothing
below is shipped — it is the shape every real one already has, and following it
is the whole opt-in.

### 1. The connector package

```sh
mkdir -p connectors/destinations/klaviyo/v1/{src,test/fixtures}
```

`package.json` names it `@polaris/destination-klaviyo-v1` and declares only what
the law allows:

```json
{
  "name": "@polaris/destination-klaviyo-v1",
  "dependencies": {
    "@polaris/delivery-destinations": "workspace:*",
    "@polaris/delivery-normalize": "workspace:*",
    "@polaris/delivery-port": "workspace:*",
    "zod": "^4.4.3"
  }
}
```

`pnpm-workspace.yaml` already globs `connectors/*/*/*`, so `pnpm install` picks
it up with no edit. Copy `tsconfig.json` and `vitest.config.ts` from any
sibling; both are boilerplate and identical across the five.

### 2. The vendor's own files

Five modules, in the order they are easiest to write:

| File | Holds |
|------|-------|
| `src/types.ts` | the vendor's wire shape, and the parsed form of its secret |
| `src/descriptor-identity.ts` | `CONSUMER_IDENTITY` — vendor, component, and the four per-stage version literals stamped on every delivery record |
| `src/mapper.ts` | one mapper per canonical event, pure: no network, no state, and no access to the raw envelope |
| `src/deliverer.ts` | `buildKlaviyoDeliverer(options)` — the only code here that touches the network |
| `src/project-config.ts` | `PROJECT_CONFIG_NAMESPACE` + `projectConfigSchema`, the per-`(project, environment)` keys an operator may set |

Every key `project-config.ts` declares must be READ by `deliverer.ts`;
`scripts/lint-project-config-keys.mjs` fails the build otherwise, because a key
an operator can set and watch change nothing is worse than no key at all.

### 3. The port implementation

`src/connector.ts` is the registry entry:

```ts
export const klaviyoConnector: DestinationConnector<KlaviyoPayload, CreateKlaviyoDescriptorOptions> =
  defineDestinationConnector({
    slug: "klaviyo",
    supportedModes: ["event"],
    identity: CONSUMER_IDENTITY,
    projectConfigNamespace: PROJECT_CONFIG_NAMESPACE,
    map: MAPPERS,
    deliver: buildKlaviyoDeliverer,
    requiredConsent: REQUIRED_CONSENT,
    identityHashing: IDENTITY_HASHING,
  });

export function createKlaviyoDescriptor(
  options: CreateKlaviyoDescriptorOptions,
): DestinationDescriptor<KlaviyoPayload> {
  return toDestinationDescriptor(klaviyoConnector, options);
}
```

`supportedModes` is declared rather than inferred. Klaviyo has a list API as
well as an events API, but until code here speaks it the connector supports
`event` and says so, and a dispatcher handed a list job can refuse it instead of
discovering the gap mid-delivery. When the list operations land they land
beside `deliver` in this same connector — not in a second one.

### 4. Register the project-config schema

Add a row to `REGISTRY` in `scripts/project-config-schemas-generate.mjs`:

```js
{
  namespace: "klaviyo",
  packageName: "@polaris/destination-klaviyo-v1",
  distEntry: "connectors/destinations/klaviyo/v1/dist/project-config.js",
},
```

then `pnpm config-schemas`. That regenerates `@polaris/tenancy-config-schemas`,
which is what the admin UI's typed form and `polaris config validate` work
from. `pnpm config-schemas:check` is the gate's copy of the same run.

### 5. Tests

`test/mapper.test.ts` and `test/deliverer.test.ts` cover the two stages;
`test/integration.test.ts` drives `createKlaviyoDescriptor` through
`createDestinationConsumer` with in-memory adapters, so the full
normalize → map → deliver → record path runs with no broker and no PostgreSQL.
`test/fixtures/` holds the golden input/output pairs the vendor's `SPEC.md`
points at. Copy the shape from `connectors/destinations/ga4/v1/test/`.

### 6. Decide the deployment — separately

Everything above supports the vendor. Running it is a different question with a
different answer per vendor, and §"The registry rule" is the reason it is
asked here rather than assumed:

- **Bound into an existing engine** — the engine imports the connector and
  passes it to `buildDestinationHost`. No new queue set, no new image, no port.
  This is the default the rule names, and it is what the pooled
  `sync/destinations/delivery/v1` will make routine.
- **Its own deployable** — a unit under `sync/destinations/klaviyo/v1` holding
  `app.ts`, `config.ts`, `main.ts` and a `Dockerfile`, plus a `POLARIS_COMPONENTS`
  entry in `libs/bus/src/topology.ts` (without it the broker discards DLQ
  publishes to the undeclared queue, silently) and a row in
  `infra/service-ports.json`. This is what the five have today, and it is a
  choice each of them made rather than a consequence of existing.

Destination INSTANCES — credentials, per-project enablement — are never in git
either way. They are rows created through `polaris destinations` and the
control-plane API, because a credential is state-of-now rather than declared
intent.

## What `v1` protects

Connector versions exist for **audit and canary**: "what did we send to Meta in
March" has to be answerable, and a mapping change has to be able to run beside
its predecessor on a slice of traffic before it takes all of it. The four
version literals in `descriptor-identity.ts` are stamped onto every
`delivery_records` row so both questions can be asked of the data.

They do **not** protect replay, and reading `v1` as if they did is the mistake
this paragraph exists to prevent. Delivery is effectful: the vendor has already
received what we sent, and re-running a mapper cannot un-send it. Replay in
Polaris stops at the effect boundary — it rebuilds derived state, and it does
not re-deliver. That is why a connector may fix a mapping bug in place where
`libs/identity` may not: `resolver/vN` output is a correctness contract because
unmerge is replay-rebuild, and a destination's is not.
