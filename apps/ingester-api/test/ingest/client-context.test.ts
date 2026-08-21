import { describe, expect, it } from "vitest";

import {
  applyClientContext,
  type ClientConnection,
  CLIENT_CONTEXT_OPT_OUT_IP,
  type ClientContextConfig,
  selectClientAddress,
} from "../../src/ingest/client-context.js";

const ON: ClientContextConfig = { stampClientContext: true, forwardedTrustDepth: 0 };

function connection(overrides: Partial<ClientConnection> = {}): ClientConnection {
  return { peerAddress: null, forwardedFor: null, userAgent: null, ...overrides };
}

/** An event shaped like a producer payload, with an empty context block. */
function event(context: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "page.viewed",
    context: { ip: null, user_agent: null, locale: "pt-BR", page: null, campaign: null, ...context },
  };
}

function contextOf(result: { readonly event: Record<string, unknown> }): Record<string, unknown> {
  return result.event["context"] as Record<string, unknown>;
}

function outcomeFor(
  result: { readonly outcomes: readonly { field: string; outcome: string }[] },
  field: string,
): string | undefined {
  return result.outcomes.find((entry) => entry.field === field)?.outcome;
}

describe("selectClientAddress — trust depth", () => {
  it("takes the socket peer at depth 0 and ignores X-Forwarded-For entirely", () => {
    const selected = selectClientAddress(
      connection({ peerAddress: "198.51.100.7", forwardedFor: "203.0.113.10" }),
      0,
    );
    expect(selected).toBe("198.51.100.7");
  });

  it("takes the client address and not the proxy at depth 1 behind one proxy", () => {
    // The proxy appended the address it accepted the connection from, so
    // the right-most entry is the client and the peer is the proxy.
    const selected = selectClientAddress(
      connection({ peerAddress: "10.0.0.1", forwardedFor: "203.0.113.10" }),
      1,
    );
    expect(selected).toBe("203.0.113.10");
  });

  it("cannot be moved past the configured depth by a spoofed extra hop", () => {
    // The client sent `X-Forwarded-For: 1.2.3.4` itself; the one trusted
    // proxy appended what it actually saw. Indexing from the right pins
    // the selection to the trusted hop no matter how long the prefix is.
    const spoofed = connection({
      peerAddress: "10.0.0.1",
      forwardedFor: "1.2.3.4, 5.6.7.8, 203.0.113.10",
    });
    expect(selectClientAddress(spoofed, 1)).toBe("203.0.113.10");
    // And at depth 2 it lands on the next trusted hop, still not on the
    // attacker-controlled head of the chain.
    expect(selectClientAddress(spoofed, 2)).toBe("5.6.7.8");
  });

  it("selects nothing when the chain is shorter than the configured depth", () => {
    // Two trusted proxies are configured but only one hop arrived: the
    // real client address is not in the chain, and the entry sitting in
    // the trusted position is producer-controlled.
    expect(selectClientAddress(connection({ forwardedFor: "203.0.113.10" }), 2)).toBeNull();
    expect(selectClientAddress(connection({ peerAddress: "10.0.0.1" }), 1)).toBeNull();
  });

  it("rejects a chain entry that is not an address", () => {
    // Ports are legal in a forwarding chain and are not addresses; geo
    // would reject the value, so the ingester never stamps it.
    expect(selectClientAddress(connection({ forwardedFor: "203.0.113.10:4711" }), 1)).toBeNull();
    expect(selectClientAddress(connection({ forwardedFor: "unknown" }), 1)).toBeNull();
  });

  it("unwraps an IPv4-mapped peer address from a dual-stack listener", () => {
    expect(selectClientAddress(connection({ peerAddress: "::ffff:203.0.113.10" }), 0)).toBe(
      "203.0.113.10",
    );
  });

  it("keeps a real IPv6 address exactly as it arrived", () => {
    expect(selectClientAddress(connection({ peerAddress: "2001:db8::1" }), 0)).toBe("2001:db8::1");
  });
});

describe("applyClientContext — eligibility", () => {
  it("stamps for a browser key and for a mobile key", () => {
    // `web` is the CONTROL PLANE's word for a browser source and is what
    // `auth.source.type` actually carries; `browser` is the envelope's.
    // Matching only the latter would never fire on real traffic.
    for (const sourceType of ["browser", "web", "mobile"]) {
      const result = applyClientContext(
        event(),
        connection({ peerAddress: "203.0.113.10", userAgent: "Mozilla/5.0" }),
        sourceType,
        ON,
      );
      expect(contextOf(result)["ip"], sourceType).toBe("203.0.113.10");
      expect(contextOf(result)["user_agent"], sourceType).toBe("Mozilla/5.0");
    }
  });

  it("leaves every server-side key untouched and uncounted", () => {
    // Both enums' server-side values: `backend`, `server`, `internal` from
    // the envelope, and `webhook`, `job` from the control plane.
    for (const sourceType of ["backend", "server", "internal", "webhook", "job"]) {
      const result = applyClientContext(
        event(),
        connection({ peerAddress: "203.0.113.10", userAgent: "Mozilla/5.0" }),
        sourceType,
        ON,
      );
      expect(contextOf(result)["ip"], sourceType).toBeNull();
      expect(contextOf(result)["user_agent"], sourceType).toBeNull();
      expect(result.outcomes, sourceType).toEqual([]);
    }
  });

  it("reads the key's source type, never the producer-sent one", () => {
    // `stampTrustedMetadata` deliberately lets a producer keep its own
    // `source.type`, so a backend key claiming to be a browser must not
    // acquire an address it has no business having.
    const claiming = { ...event(), source: { type: "browser", id: "payments-api" } };
    const result = applyClientContext(
      claiming,
      connection({ peerAddress: "203.0.113.10" }),
      "backend",
      ON,
    );
    expect(contextOf(result)["ip"]).toBeNull();
  });

  it("does nothing to an event carrying no object context", () => {
    // Such an event fails `invalid_envelope` on its own merits; counting
    // it would put non-candidates on the rollout panel.
    for (const broken of [{ event: "page.viewed" }, { event: "x", context: null }]) {
      const result = applyClientContext(broken, connection({ peerAddress: "203.0.113.10" }), "browser", ON);
      expect(result.event).toBe(broken);
      expect(result.outcomes).toEqual([]);
    }
  });
});

describe("applyClientContext — producer values win", () => {
  it("keeps a producer-sent address and user agent, which is the relay case", () => {
    const result = applyClientContext(
      event({ ip: "198.51.100.99", user_agent: "RelayAgent/2" }),
      connection({ peerAddress: "203.0.113.10", userAgent: "Mozilla/5.0" }),
      "browser",
      ON,
    );
    expect(contextOf(result)["ip"]).toBe("198.51.100.99");
    expect(contextOf(result)["user_agent"]).toBe("RelayAgent/2");
    expect(outcomeFor(result, "ip")).toBe("producer");
    expect(outcomeFor(result, "user_agent")).toBe("producer");
  });

  it("normalises the 0.0.0.0 opt-out to null and records it", () => {
    const result = applyClientContext(
      event({ ip: CLIENT_CONTEXT_OPT_OUT_IP }),
      connection({ peerAddress: "203.0.113.10" }),
      "browser",
      ON,
    );
    expect(contextOf(result)["ip"]).toBeNull();
    expect(outcomeFor(result, "ip")).toBe("opted_out");
  });

  it("honours the opt-out on a backend key too, without counting it", () => {
    // The sentinel is the producer's instruction, not a browser
    // affordance, so it is obeyed whoever holds the key — otherwise the
    // literal `0.0.0.0` would reach the store and geo would look it up.
    const result = applyClientContext(
      event({ ip: CLIENT_CONTEXT_OPT_OUT_IP }),
      connection(),
      "backend",
      ON,
    );
    expect(contextOf(result)["ip"]).toBeNull();
    expect(result.outcomes).toEqual([]);
  });
});

describe("applyClientContext — the environment switch", () => {
  it("stamps nothing when stamping is off, and says so", () => {
    const result = applyClientContext(
      event(),
      connection({ peerAddress: "203.0.113.10", userAgent: "Mozilla/5.0" }),
      "browser",
      { stampClientContext: false, forwardedTrustDepth: 0 },
    );
    expect(contextOf(result)["ip"]).toBeNull();
    expect(contextOf(result)["user_agent"]).toBeNull();
    expect(outcomeFor(result, "ip")).toBe("disabled");
    expect(outcomeFor(result, "user_agent")).toBe("disabled");
  });

  it("still honours the opt-out when stamping is off", () => {
    // The switch only ever removes data; a producer asking for less than
    // the switch already gives must not be answered with more.
    const result = applyClientContext(
      event({ ip: CLIENT_CONTEXT_OPT_OUT_IP }),
      connection(),
      "browser",
      { stampClientContext: false, forwardedTrustDepth: 0 },
    );
    expect(contextOf(result)["ip"]).toBeNull();
    expect(outcomeFor(result, "ip")).toBe("opted_out");
  });
});

describe("applyClientContext — nothing usable to stamp", () => {
  it("reports unavailable rather than stamping a value the envelope rejects", () => {
    // `contextSchema` caps `user_agent` at 1024 characters. Stamping a
    // longer one would turn a header the producer does not control into
    // an `invalid_envelope` rejection of an otherwise-valid event.
    const result = applyClientContext(
      event(),
      connection({ userAgent: "M".repeat(1025) }),
      "browser",
      ON,
    );
    expect(contextOf(result)["user_agent"]).toBeNull();
    expect(outcomeFor(result, "user_agent")).toBe("unavailable");
  });

  it("reports unavailable when the connection offered no address", () => {
    const result = applyClientContext(event(), connection(), "browser", ON);
    expect(contextOf(result)["ip"]).toBeNull();
    expect(outcomeFor(result, "ip")).toBe("unavailable");
    expect(outcomeFor(result, "user_agent")).toBe("unavailable");
  });
});
