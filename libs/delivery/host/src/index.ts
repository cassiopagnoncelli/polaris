/**
 * `@polaris/delivery-host` — the bootstrap a vendor consumer's `app.ts`
 * used to write for itself.
 *
 * A separate package from `@polaris/delivery-destinations` on purpose. That
 * package is the delivery RUNTIME and is deliberately dependency-light — its
 * `ProjectConfigLookup` is a one-method seam specifically so a consumer that
 * has not cut over does not take a dependency on
 * `@polaris/tenancy-project-config`. Putting a Fastify bootstrap, a project
 * config store and a Prometheus renderer inside it would invert that: every
 * consumer of the runtime would pull the whole service tier.
 *
 * So the layering is:
 *
 *   delivery-destinations   the runtime. Delivery, gate, retry, breaker.
 *   delivery-host           the process around it. Postgres, AMQP, Fastify,
 *                           shutdown ordering.
 *   connectors/destinations/*  the vendor: map + deliver, and nothing else.
 *   sync/destinations/*     config + the wiring that binds one, and nothing else.
 *
 * That split is also the reason the five `app.ts` files were never
 * consolidated before: the obvious home for the code was the runtime
 * package, and it does not belong there.
 */

export {
  type BuiltDestinationHost,
  buildDestinationHost,
  type DestinationHostConfig,
  type DestinationHostInput,
  type DestinationHostOverrides,
} from "./host.js";
