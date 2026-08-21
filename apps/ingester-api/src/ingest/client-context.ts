import { isIP } from "node:net";

import { contextSchema } from "@polaris/spec";

/**
 * Client context stamped from the connection: `context.ip` and
 * `context.user_agent`.
 *
 * A browser cannot know its own public address. Every direct-browser event
 * therefore reached `enrichment.geo` with `ip: null` (`source: no_ip`) and
 * reached Meta CAPI and TikTok without `client_ip_address` — the signal
 * existed only on the relay path, where a first-party server stamped it.
 * So the ingester stands in for the producer's connection, exactly as
 * Segment's API does, and fills the two fields the connection can answer.
 *
 * The values stay in `context`, which is the block for what the PRODUCER
 * observed, and do NOT move into `enrichment`. That is not sloppiness about
 * the split: the ingester is acting as the producer's own edge here, the
 * same way a first-party relay does, and `enrichment` is for what Polaris
 * DERIVED (`enrichment.geo` is derived — from this field). See
 * `docs/architecture/04-ingestion-and-sdks.md`.
 *
 * ## Only browser- and mobile-typed keys
 *
 * Eligibility reads `auth.source.type` — the API key's type — never the
 * producer-sent `source.type`, which `stampTrustedMetadata` deliberately
 * lets through. A backend key claiming `type: "browser"` in its payload
 * gets nothing stamped.
 *
 * Server-side keys are never stamped: a server's own address is noise, and
 * a relay's address stamped as the end user's would be worse than noise.
 * The relay path keeps working because a producer-sent non-null value is
 * ALWAYS kept.
 *
 * ## Two vocabularies name the same thing
 *
 * There are two `source.type` enums in this repository, and they disagree
 * on the word for a browser:
 *
 *   - the CONTROL PLANE stores `web | backend | mobile | webhook | job`
 *     (`sources_source_type_allowed`, mirrored by `SourceType` in
 *     `libs/persistence/postgres/src/database.ts`);
 *   - the ENVELOPE declares `browser | backend | mobile | server | internal`
 *     (`sourceSchema` in `libs/spec/src/envelope/primitives.ts`).
 *
 * `auth.source.type` is read straight off `api_keys.source_type`, so what
 * actually arrives here for a real browser key is **`web`**. Matching only
 * the envelope's `browser` would have shipped a feature that never fired on
 * the exact traffic it was built for — the ingester would have gone on
 * stamping nothing, and the counter below would have read a flat zero that
 * looks like "no browser traffic".
 *
 * So both words are accepted. Reconciling the two enums is a real piece of
 * work — a migration and every reader of either — and it is not this
 * module's to do; what this module owes is to be right about the values it
 * is actually handed.
 *
 * ## Which forwarding header
 *
 * `X-Forwarded-For` only, selected by an explicit trust depth. The
 * alternatives cannot be honoured without ambiguity, which is the bar the
 * card set:
 *
 *   - `X-Real-IP` carries one address and no hop count, so no trust depth
 *     can be expressed against it — behind two proxies you get whatever the
 *     last one wrote and cannot tell that you did.
 *   - `Forwarded` (RFC 7239) is a list and a depth would apply, but its
 *     `for=` values may be quoted, port-suffixed, or obfuscated
 *     (`for=_hidden`), and when it disagrees with `X-Forwarded-For` nothing
 *     says which wins.
 *
 * A deployment that terminates on something speaking only `X-Real-IP` sets
 * depth `0` and gets the socket peer — the honest answer for that topology,
 * rather than a guess.
 */

/** `context.ip` values the ingester fills, and how it decided. */
export type ClientContextField = "ip" | "user_agent";

/**
 * What happened to one field on one event.
 *
 *   - `stamped`     filled from the connection.
 *   - `producer`    the producer sent a value; it was kept.
 *   - `opted_out`   the producer sent {@link CLIENT_CONTEXT_OPT_OUT_IP};
 *                   normalised to `null`.
 *   - `unavailable` eligible and empty, but the connection offered nothing
 *                   usable. Non-zero means the trust depth does not match
 *                   the deployment, or a proxy is stripping the header —
 *                   the failure that would otherwise be invisible, because
 *                   "nothing stamped" and "no browser traffic" look
 *                   identical on a counter that only counts successes.
 *   - `disabled`    {@link ClientContextConfig.stampClientContext} is off
 *                   for this environment.
 */
export type ClientContextOutcome =
  | "stamped"
  | "producer"
  | "opted_out"
  | "unavailable"
  | "disabled";

export interface ClientContextFieldOutcome {
  readonly field: ClientContextField;
  readonly outcome: ClientContextOutcome;
}

/**
 * The connection facts the route reads off the request. Deliberately raw
 * strings: the header is read here and selected here, so the rules live in
 * one testable place instead of half in a Fastify hook.
 */
export interface ClientConnection {
  /** Socket peer address, or `null` when the platform exposed none. */
  readonly peerAddress: string | null;
  /** `X-Forwarded-For`, unparsed. */
  readonly forwardedFor: string | null;
  /** `User-Agent`, unparsed. */
  readonly userAgent: string | null;
}

export interface ClientContextConfig {
  readonly stampClientContext: boolean;
  readonly forwardedTrustDepth: number;
}

export interface ClientContextResult {
  /** The event, with `context` replaced only when something changed. */
  readonly event: Record<string, unknown>;
  /**
   * One entry per field the counter should record, empty when the event is
   * outside the feature's world (see {@link applyClientContext}).
   */
  readonly outcomes: readonly ClientContextFieldOutcome[];
}

/**
 * Segment's convention: a producer sending this address means "do not
 * collect my IP". Honoured whatever the key's source type — it is the
 * producer's instruction, not a browser affordance — and normalised to
 * `null` so the sentinel never reaches the store, where geo would treat it
 * as an address to look up (a `miss`) rather than as an absent one.
 */
export const CLIENT_CONTEXT_OPT_OUT_IP = "0.0.0.0" as const;

/**
 * API key source types whose clients cannot know their own address.
 *
 * `web` and `browser` are the same thing under the two enums described in
 * the module header; `mobile` is spelled the same in both. Everything else
 * is server-side and stays out: `backend`, `server`, `internal` from the
 * envelope, and `webhook`, `job` from the control plane.
 */
const STAMPABLE_SOURCE_TYPES: ReadonlySet<string> = new Set(["browser", "web", "mobile"]);

/** `::ffff:203.0.113.10` — IPv4 arriving on a dual-stack listener. */
const IPV4_MAPPED = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i;

/**
 * Fill `context.ip` / `context.user_agent` from the connection.
 *
 * Runs on the output of `stampTrustedMetadata`, before the forbidden-field
 * policy and before catalog validation, so a stamped value is validated
 * exactly like a producer-sent one. It does NOT reach the quarantine
 * snapshot: that records the producer's raw payload, so a platform-observed
 * address never lands in a violation record.
 *
 * The event is returned unchanged, with no outcomes, when it carries no
 * object `context`. Synthesising one would not help — `contextSchema`
 * requires all five keys, so such an event is `invalid_envelope` on its own
 * merits — and counting it would put events that were never candidates on
 * the rollout panel.
 */
export function applyClientContext(
  event: Readonly<Record<string, unknown>>,
  connection: ClientConnection,
  sourceType: string,
  config: ClientContextConfig,
): ClientContextResult {
  const context = event["context"];
  if (context === null || typeof context !== "object" || Array.isArray(context)) {
    return { event: event as Record<string, unknown>, outcomes: [] };
  }
  const incoming = context as Record<string, unknown>;

  const producerIp = readNonEmptyString(incoming, "ip");
  const optedOut = producerIp === CLIENT_CONTEXT_OPT_OUT_IP;
  const eligible = STAMPABLE_SOURCE_TYPES.has(sourceType);

  if (!eligible) {
    // The counter is scoped to the keys the feature is about, so a backend
    // key contributes nothing to it. The opt-out still fires, because a
    // producer that asked us not to keep its address is owed that whichever
    // kind of key it holds.
    if (!optedOut) return { event: event as Record<string, unknown>, outcomes: [] };
    return { event: { ...event, context: { ...incoming, ip: null } }, outcomes: [] };
  }

  const next: Record<string, unknown> = { ...incoming };
  const outcomes: ClientContextFieldOutcome[] = [];

  // ---- context.ip ------------------------------------------------------
  if (optedOut) {
    next["ip"] = null;
    outcomes.push({ field: "ip", outcome: "opted_out" });
  } else if (producerIp !== null) {
    outcomes.push({ field: "ip", outcome: "producer" });
  } else if (!config.stampClientContext) {
    outcomes.push({ field: "ip", outcome: "disabled" });
  } else {
    const address = selectClientAddress(connection, config.forwardedTrustDepth);
    if (address !== null && contextSchema.shape.ip.safeParse(address).success) {
      next["ip"] = address;
      outcomes.push({ field: "ip", outcome: "stamped" });
    } else {
      outcomes.push({ field: "ip", outcome: "unavailable" });
    }
  }

  // ---- context.user_agent ---------------------------------------------
  // No opt-out sentinel: Segment's convention covers the address only, and
  // inventing a second one would surprise the producers this convention
  // exists to keep working.
  const producerAgent = readNonEmptyString(incoming, "user_agent");
  if (producerAgent !== null) {
    outcomes.push({ field: "user_agent", outcome: "producer" });
  } else if (!config.stampClientContext) {
    outcomes.push({ field: "user_agent", outcome: "disabled" });
  } else {
    const agent = connection.userAgent?.trim() ?? "";
    // Checked against the envelope's own schema rather than a copied
    // constant: stamping a value the contract rejects would turn a header
    // the producer does not control into an `invalid_envelope` rejection of
    // an otherwise-valid event.
    if (agent.length > 0 && contextSchema.shape.user_agent.safeParse(agent).success) {
      next["user_agent"] = agent;
      outcomes.push({ field: "user_agent", outcome: "stamped" });
    } else {
      outcomes.push({ field: "user_agent", outcome: "unavailable" });
    }
  }

  return { event: { ...event, context: next }, outcomes };
}

/**
 * Choose the client address for a configured number of trusted proxies.
 *
 * Depth `0` is the socket peer — no proxy is trusted, so `X-Forwarded-For`
 * is producer-controlled text and is not read at all. Depth `n` takes the
 * n-th address from the RIGHT of the chain, because each proxy appends the
 * address it saw: behind one trusted proxy the right-most entry is the
 * address that proxy accepted the connection from, and everything left of
 * it is whatever the client chose to send. Indexing from the right is what
 * makes a spoofed extra hop unable to move the selection — prepending
 * addresses only lengthens the untrusted prefix.
 *
 * A chain SHORTER than the configured depth selects nothing. The deployment
 * contract says n proxies are in front; a chain with fewer entries means
 * that is not true right now, and the address at the far left is then a
 * client-controlled value sitting in a position the config says to trust.
 * Stamping nothing is the only answer that cannot be forged into.
 */
export function selectClientAddress(
  connection: ClientConnection,
  trustDepth: number,
): string | null {
  if (trustDepth <= 0) return normaliseAddress(connection.peerAddress);
  const chain = (connection.forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (chain.length < trustDepth) return null;
  return normaliseAddress(chain[chain.length - trustDepth]);
}

/**
 * Validate an address and unwrap the one transport artefact worth undoing.
 *
 * `isIP` is the same guard `sync/enrichment/geoip/v1/src/ip.ts` applies, so
 * the ingester never stamps a value the geo stage would reject — including
 * a `host:port` entry, which is legal in a forwarding chain and is not an
 * address. IPv6 is otherwise left exactly as it arrived, matching that
 * module's choice not to canonicalise.
 *
 * The IPv4-mapped form is unwrapped because it is an artefact of OUR
 * listening socket, not of the client: a dual-stack listener reports
 * `::ffff:203.0.113.10` for a client whose address is `203.0.113.10`, and
 * the vendors that receive this field want the address the client has.
 */
function normaliseAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const address = IPV4_MAPPED.exec(trimmed)?.[1] ?? trimmed;
  return isIP(address) === 0 ? null : address;
}

/** A present, non-empty string field, or `null` for anything else. */
function readNonEmptyString(source: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
