/**
 * The routing gate — stage 4's decision about whether an event is FOR this
 * destination instance at all.
 *
 * Until now every event that reached a consumer was normalized, mapped and
 * delivered; a vendor that only wanted purchases received page views and
 * decided per mapper, which put a routing question inside vendor-specific
 * code and made "why did this event reach Braze?" a code-reading exercise.
 * The gate moves that decision in front of normalize, where it is one
 * evaluation against configuration an operator can read.
 *
 * ## The order is the contract
 *
 *   subscription  ->  filters  ->  consent  ->  (normalize)
 *
 * Cheapest and most selective first: an unsubscribed event name is decided
 * by a set lookup, a filter by walking a couple of envelope paths, consent
 * by the shared evaluator. Reordering would not change WHICH events pass —
 * all three must pass — but it changes the REASON recorded for those that
 * do not, and the reason is the whole operational value of the record. An
 * event that is both unsubscribed and consent-denied is reported as
 * unsubscribed, because that is the fact an operator can act on.
 *
 * ## What the gate is not
 *
 * Not a mapping layer. Configuration decides WHETHER an event goes to a
 * vendor, never WHAT it looks like when it gets there — that lives in
 * versioned mapper code, and `assertNoMappingSemantics` refuses config keys
 * that smell like field maps. A gate that could rewrite payloads would put
 * vendor semantics in a database row, which is the one thing the
 * destination architecture exists to prevent.
 *
 * Not a consent redefinition. It reuses `evaluateConsent`, so absent-as-true
 * holds exactly as before: an instance may REQUIRE a dimension the vendor
 * descriptor does not, but an absent consent block still grants it. Changing
 * that would silently start dropping events for every existing project.
 *
 * ## Absent config subscribes to everything
 *
 * A project with no gate configuration behaves byte-identically to the
 * harness before this existed. That is what makes the gate safe to land
 * ahead of the vendor flips: nothing changes until someone configures it.
 */

import {
  CONSENT_DIMENSIONS,
  type ConsentDimension,
  type EnvelopeConsent,
  evaluateConsent,
  type RequiredConsent,
} from "@polaris/shared-destination-normalize";

/**
 * Envelope roots a filter may address.
 *
 * A closed set, because a filter is evaluated against the canonical
 * envelope BEFORE normalize — which is to say, against raw customer data
 * including whatever identifiers the producer sent. Allowing arbitrary
 * paths would let a config value route on an email address, turning the
 * routing table into a place PII accumulates in plaintext, readable by
 * anyone with control-plane access.
 *
 * So: the event name, the properties a producer chose to send, the
 * platform's own enrichment, and the profile's traits. Notably absent is
 * `identity` — routing on who someone IS rather than on what they DID is
 * both a privacy hazard and, with a profile plane one hop upstream, the
 * wrong tool: filter on a trait instead.
 */
export const FILTERABLE_ROOTS = [
  "event",
  "properties",
  "context",
  "profile",
  "enrichment",
] as const;
export type FilterableRoot = (typeof FILTERABLE_ROOTS)[number];

/** Comparisons a property filter may use. */
export const FILTER_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "exists",
  "not_exists",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * One property filter.
 *
 * `path` is dot-delimited from a filterable root, e.g. `properties.plan`,
 * `profile.traits.tier`, `enrichment.geo.country`.
 */
export interface PropertyFilter {
  readonly path: string;
  readonly op: FilterOperator;
  /** Absent for `exists` / `not_exists`. */
  readonly value?: string | number | boolean | readonly (string | number | boolean)[] | undefined;
}

/**
 * Which events an instance wants.
 *
 * `events` matches exact names, `prefixes` matches on `.`-delimited
 * namespaces (`payment.` matches `payment.approved`). Both absent means
 * every event — see the module header.
 */
export interface SubscriptionConfig {
  readonly events?: readonly string[] | undefined;
  readonly prefixes?: readonly string[] | undefined;
}

/** The gate's whole configuration for one instance. */
export interface RoutingGateConfig {
  readonly subscriptions?: SubscriptionConfig | undefined;
  readonly filters?: readonly PropertyFilter[] | undefined;
  /** Consent dimensions this INSTANCE requires, beyond the vendor's own. */
  readonly requireConsent?: readonly ConsentDimension[] | undefined;
}

/** Why the gate refused an event. */
export type GateSkipReason = "unsubscribed" | "filtered" | "consent";

export type GateDecision =
  | { readonly kind: "pass" }
  | {
      readonly kind: "skip";
      readonly reason: GateSkipReason;
      /** Operator-facing detail, recorded on the delivery row. */
      readonly detail: string;
    };

/**
 * The slice of the envelope the gate reads.
 *
 * The filterable roots are `unknown` rather than record types, and that is
 * the honest signature: a filter path is a runtime string, so every step of
 * resolving it is a structural check regardless of what the compiler was
 * told. Declaring them as records would only force a cast at the one call
 * site that matters — the canonical envelope, whose `context` is a typed
 * object and whose `profile` is nullable — and buy nothing, since a
 * three-segment path leaves the declared type behind at the first hop.
 */
export interface GateEnvelope {
  readonly event: string;
  readonly properties?: unknown;
  readonly context?: unknown;
  readonly profile?: unknown;
  readonly enrichment?: unknown;
  readonly consent?: EnvelopeConsent | null | undefined;
}

/**
 * Decide whether this instance wants this event.
 *
 * Pure: no clock, no I/O, no vendor knowledge. The runtime supplies the
 * config it already resolved for the batch, so the gate never reads a
 * database — a per-event config read would put a round trip in front of
 * every delivery for a value that changes on the order of days.
 */
export function evaluateGate(input: {
  readonly envelope: GateEnvelope;
  readonly config: RoutingGateConfig | undefined;
  /** The vendor's own declared consent, from the descriptor. */
  readonly vendorConsent: RequiredConsent;
}): GateDecision {
  const config = input.config ?? {};

  const subscription = checkSubscription(input.envelope.event, config.subscriptions);
  if (subscription !== undefined) return subscription;

  const filtered = checkFilters(input.envelope, config.filters ?? []);
  if (filtered !== undefined) return filtered;

  return checkConsent(input.envelope, config.requireConsent ?? [], input.vendorConsent);
}

function checkSubscription(
  event: string,
  subscriptions: SubscriptionConfig | undefined,
): GateDecision | undefined {
  const events = subscriptions?.events;
  const prefixes = subscriptions?.prefixes;
  // Neither declared: subscribe to everything, which is what an
  // unconfigured project has always done.
  if (
    (events === undefined || events.length === 0) &&
    (prefixes === undefined || prefixes.length === 0)
  ) {
    return undefined;
  }
  if (events?.includes(event) === true) return undefined;
  if (prefixes?.some((prefix) => event.startsWith(prefix)) === true) return undefined;
  return {
    kind: "skip",
    reason: "unsubscribed",
    detail: `event "${event}" is not in this instance's subscriptions`,
  };
}

function checkFilters(
  envelope: GateEnvelope,
  filters: readonly PropertyFilter[],
): GateDecision | undefined {
  for (const filter of filters) {
    if (!matches(envelope, filter)) {
      return {
        kind: "skip",
        reason: "filtered",
        // The PATH and the operator, never the envelope's value: a
        // delivery record is widely readable and the value may be
        // customer data. An operator debugging a filter has the config
        // and the event; they do not need the value echoed into a table.
        detail: `filter ${filter.path} ${filter.op} did not match`,
      };
    }
  }
  return undefined;
}

function checkConsent(
  envelope: GateEnvelope,
  instanceRequires: readonly ConsentDimension[],
  vendorConsent: RequiredConsent,
): GateDecision {
  if (instanceRequires.length === 0) return { kind: "pass" };

  // Union with the vendor's declaration rather than replacing it: an
  // instance may require MORE than its vendor does, never less. A config
  // value that could relax a vendor's consent requirement would let a
  // database row undo a compliance decision made in code.
  const required: RequiredConsent = { ...vendorConsent };
  for (const dimension of instanceRequires) {
    (required as Record<ConsentDimension, boolean>)[dimension] = true;
  }

  const evaluation = evaluateConsent(envelope.consent ?? undefined, required);
  if (evaluation.status === "granted") return { kind: "pass" };
  return {
    kind: "skip",
    reason: "consent",
    detail: `consent dimension "${evaluation.deniedBy}" not granted`,
  };
}

/**
 * The project-config key the gate reads.
 *
 * Singular and semantics-free by necessity: `assertNoMappingSemantics`
 * refuses any key normalising to `map`, `mapping`, `field_map` and friends
 * at the control-plane write path, so `routing_map` could never be stored.
 * The name is also the honest one — this decides WHETHER, never WHAT.
 */
export const ROUTING_GATE_CONFIG_KEY = "routing";

/**
 * Read a gate config out of the raw project-config bag.
 *
 * Returns `undefined` for absent OR malformed configuration, and that
 * degradation is safe for a reason worth stating: the gate can only ever
 * SUBTRACT deliveries. Ignoring a broken config falls back to the pre-gate
 * behaviour, in which normalize still applies the vendor's own consent
 * requirement independently — so a malformed value can never cause an event
 * to be sent that the harness would not have sent yesterday. Failing closed
 * instead would mute a destination over a typo, which is the louder failure
 * and the one an operator cannot diagnose from the vendor's side.
 *
 * Whole-config rejection rather than per-section: an operator writes the
 * routing block as one unit, and silently applying half of it is the more
 * surprising outcome. Either it is valid or the instance is unconfigured.
 *
 * Structural validation only. Values are not checked against the envelope —
 * a filter naming a path no event carries is legal configuration and simply
 * never matches.
 */
export function parseRoutingGateConfig(value: unknown): RoutingGateConfig | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const subscriptions = parseSubscriptions(raw["subscriptions"]);
  if (subscriptions === INVALID) return undefined;

  const filters = parseFilters(raw["filters"]);
  if (filters === INVALID) return undefined;

  const requireConsent = parseRequireConsent(raw["requireConsent"]);
  if (requireConsent === INVALID) return undefined;

  return {
    ...(subscriptions !== undefined ? { subscriptions } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(requireConsent !== undefined ? { requireConsent } : {}),
  };
}

/** Distinguishes "absent, fine" from "present and wrong" without throwing. */
const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseSubscriptions(value: unknown): SubscriptionConfig | undefined | Invalid {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return INVALID;
  const raw = value as Record<string, unknown>;
  const events = raw["events"];
  const prefixes = raw["prefixes"];
  if (events !== undefined && !isStringArray(events)) return INVALID;
  if (prefixes !== undefined && !isStringArray(prefixes)) return INVALID;
  return {
    ...(events !== undefined ? { events } : {}),
    ...(prefixes !== undefined ? { prefixes } : {}),
  };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseFilters(value: unknown): readonly PropertyFilter[] | undefined | Invalid {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return INVALID;

  const filters: PropertyFilter[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return INVALID;
    const raw = entry as Record<string, unknown>;
    const path = raw["path"];
    const op = raw["op"];
    if (typeof path !== "string" || path.length === 0) return INVALID;
    if (typeof op !== "string" || !(FILTER_OPERATORS as readonly string[]).includes(op)) {
      return INVALID;
    }
    // An unaddressable root is refused at parse time rather than resolving
    // to `undefined` at evaluation time: a filter on `identity.email` that
    // quietly never matched would read to its author as a working rule.
    const root = path.split(".")[0];
    if (root === undefined || !(FILTERABLE_ROOTS as readonly string[]).includes(root)) {
      return INVALID;
    }

    const needsValue = op !== "exists" && op !== "not_exists";
    const value_ = raw["value"];
    if (needsValue) {
      const ok = Array.isArray(value_) ? value_.every(isScalar) : isScalar(value_);
      if (!ok) return INVALID;
      filters.push({
        path,
        op: op as FilterOperator,
        value: value_ as PropertyFilter["value"],
      });
    } else {
      filters.push({ path, op: op as FilterOperator });
    }
  }
  return filters;
}

function parseRequireConsent(value: unknown): readonly ConsentDimension[] | undefined | Invalid {
  if (value === undefined) return undefined;
  if (!isStringArray(value)) return INVALID;
  // Against the normalizer's own list, not a copy of it. A dimension added
  // there would otherwise be unconfigurable here until someone noticed.
  const known: readonly string[] = CONSENT_DIMENSIONS;
  if (!value.every((entry) => known.includes(entry))) return INVALID;
  return value as ConsentDimension[];
}

/**
 * Resolve a dot path against the filterable roots. `undefined` when absent.
 *
 * Module-private: an unaddressable root is refused by `parseRoutingGateConfig`
 * before it can reach here, so the interesting behaviour is testable through
 * the parser and the evaluator. Exporting it would only invite a caller that
 * bypasses that refusal.
 */
function resolveFilterPath(envelope: GateEnvelope, path: string): unknown {
  const segments = path.split(".");
  const root = segments[0];
  if (root === undefined || !(FILTERABLE_ROOTS as readonly string[]).includes(root))
    return undefined;

  let current: unknown =
    root === "event" ? envelope.event : (envelope as unknown as Record<string, unknown>)[root];
  for (const segment of segments.slice(1)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function matches(envelope: GateEnvelope, filter: PropertyFilter): boolean {
  const actual = resolveFilterPath(envelope, filter.path);

  switch (filter.op) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "equals":
      return sameScalar(actual, filter.value);
    case "not_equals":
      return !sameScalar(actual, filter.value);
    case "in":
      return asList(filter.value).some((candidate) => sameScalar(actual, candidate));
    case "not_in":
      return !asList(filter.value).some((candidate) => sameScalar(actual, candidate));
    default:
      // Unreachable while `op` is the closed set; a config value outside it
      // is rejected by the schema before it reaches here.
      return false;
  }
}

function asList(value: PropertyFilter["value"]): readonly (string | number | boolean)[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value as string | number | boolean];
}

/**
 * Scalar comparison, deliberately strict about type.
 *
 * `"1"` does not equal `1`. JSON config and JSON envelopes both carry real
 * types, so a coercing comparison would make a filter's behaviour depend on
 * how a producer happened to serialise a value — the kind of bug that
 * surfaces as "this destination stopped receiving events" months later.
 */
function sameScalar(actual: unknown, expected: PropertyFilter["value"]): boolean {
  if (Array.isArray(expected)) return false;
  return actual === expected;
}
