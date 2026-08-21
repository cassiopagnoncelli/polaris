/**
 * meta-capi's per-`(project, environment)` configuration contract.
 *
 * The C3 generator reads this module from the built entry to produce
 * `@polaris/tenancy-config-schemas`, which the admin UI's typed form and
 * `polaris config validate` both work from. Adding a key here and
 * regenerating is the whole opt-in.
 *
 * Every key is OPTIONAL with no schema default, deliberately. Absent means
 * "use the value this consumer was constructed with" — the deployment
 * default, which is exactly what `POLARIS_META_CAPI_*` meant before the
 * cutover. A schema default would look tidier and would silently override an
 * operator who tuned those variables for their deployment.
 *
 * What is NOT here: the access token. The credential lives in `secret_value`
 * on the DESTINATION row, not in project config, and the split is deliberate
 * now that both are plaintext in the same database. A destination credential
 * belongs to one instance — two Meta pixels for one project have two — and it
 * is write-only through every Polaris surface, rotated with
 * `polaris destinations rotate-secret`. The keys here are project-wide values
 * an operator reads back routinely.
 *
 * @see docs/implementation/project-config-plan.md §3.1
 */

import { ROUTING_GATE_CONFIG_KEY } from "@polaris/delivery-destinations";
import { positiveIntSchema } from "@polaris/delivery-port";
import { z } from "zod";

/** Namespace this consumer reads. One slice per component (plan §3.5). */
export const PROJECT_CONFIG_NAMESPACE = "meta-capi";

/**
 * Parsed in STRIP mode, never `.strict()`: a project may declare free-form
 * keys this build knows nothing about, and a strict parse would fail the
 * whole slice — and therefore every delivery for that project — the moment
 * one appeared (plan §3.5).
 */
export const projectConfigSchema = z.object({
  /**
   * Routing gate configuration — WHICH events reach this destination.
   *
   * Read by the SHARED destination runtime (`libs/delivery/destinations`),
   * not by this consumer: the gate runs inside `processOne`, ahead of
   * normalize, so it is decided before any vendor code is reached. Declared
   * here anyway because the namespace is what `polaris config set` validates
   * against and what the admin panel renders — a key an operator cannot
   * discover is a key nobody uses.
   *
   * Shape: `{ subscriptions?: { events?, prefixes? }, filters?: [{ path, op,
   * value? }], requireConsent?: [...] }`. Validated structurally by
   * `parseRoutingGateConfig`, not here, because the runtime must degrade to
   * "unconfigured" on a malformed value rather than fail the slice — and a
   * Zod shape duplicated in two places is a shape that drifts.
   *
   * Never mapping semantics. Configuration decides WHETHER an event goes to
   * a vendor, never what it looks like on arrival.
   */
  [ROUTING_GATE_CONFIG_KEY]: z.record(z.string(), z.unknown()).optional(),
  /** Meta Graph API host. Overridden for staging or test endpoints. */
  graph_host: z.string().min(1).optional(),
  /** Per-attempt HTTP timeout, milliseconds. */
  request_timeout_ms: positiveIntSchema.optional(),
});

/*
 * `allow_replay` was declared here and read by nothing.
 *
 * Replay suppression runs in the destination runtime's `processOne`, at step 2,
 * long before the deliverer — and the `ProjectConfigLookup` seam only feeds
 * `DelivererContext.projectConfig`. So an operator could run
 * `polaris config set --key allow_replay --value true`, see it in
 * `config list`, and have it change nothing.
 *
 * It is not worth plumbing, either: replay already has two gates, the
 * host-level `POLARIS_META_CAPI_ALLOW_REPLAY` and the per-instance
 * `destinations.replay_opt_in`. The second is strictly better than a
 * per-project flag would be — finer-grained, audited, and with
 * `polaris destinations enable-replay` / `disable-replay` behind it.
 *
 * `scripts/lint-project-config-keys.mjs` now fails on a declared key its
 * component never reads, so this cannot recur silently.
 */

/**
 * Per-instance key: may the mapper fill Meta's `ct` / `st` / `country`
 * from `enrichment.geo` when the person's traits carry no address?
 *
 * On `destinations.config`, the narrow half of the precedence chain, and
 * NOT on `projectConfigSchema` above. Both halves would have been tidier to
 * declare in one place, and one of them would have been a lie: the mapper
 * is handed `instance.config` and nothing else, so a value stored under
 * `project_config['meta-capi']` would show up in `polaris config list`,
 * render in the admin panel, and change nothing — which is the exact defect
 * `allow_replay` shipped and `scripts/lint-project-config-keys.mjs` was
 * written to catch. The declaration lives here rather than in `mapper.ts`
 * because this module is where this connector's configuration contract is
 * written down, whichever store a given key rides in.
 *
 * Write it with:
 *
 *   polaris destinations set-config <destination_id> \
 *     --config '{"location_from_geo": true}' --reason '<why>'
 *
 * DEFAULT OFF, and that is the whole reason it is a switch. Geo is derived
 * from the connection address: a VPN exit node, a corporate egress or a
 * mobile carrier's NAT all geolocate somewhere the person is not, and a
 * wrong `ct` is a hashed match against somebody else rather than a missing
 * one. Turning it on buys location signal on anonymous traffic and accepts
 * that some of it is coarse and some of it is wrong — an operator's
 * trade-off to make per pixel, not the platform's to make for them.
 */
export const LOCATION_FROM_GEO_KEY = "location_from_geo";

/**
 * Read the geo-fallback switch off one instance's config bag.
 *
 * Strictly `=== true`. The bag is jsonb an operator hand-writes, so the
 * string `"true"`, `1` and `"yes"` all reach here; accepting them would
 * mean guessing that a typo was consent to send coarser location data, and
 * the honest read of anything that is not the boolean is "not configured".
 */
export function locationFromGeoEnabled(
  instanceValues: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return instanceValues?.[LOCATION_FROM_GEO_KEY] === true;
}

export type MetaCapiProjectConfig = z.infer<typeof projectConfigSchema>;

/**
 * Parse one raw slice, falling back to an empty result rather than throwing.
 *
 * A malformed stored value must degrade to the deployment default, not fail
 * the delivery: the value is operator-supplied and the alternative is
 * dead-lettering a producer's events over a typo in an unrelated setting.
 */
export function parseMetaCapiProjectConfig(
  values: Readonly<Record<string, unknown>>,
): MetaCapiProjectConfig {
  const result = projectConfigSchema.safeParse(values);
  return result.success ? result.data : {};
}
