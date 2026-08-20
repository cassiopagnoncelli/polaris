// @vitest-environment happy-dom
/**
 * `IdentityManager` — the public surface for identity state in the Web SDK.
 *
 * Covers:
 *
 *   - capability detection picks the doctrinal first-available layer
 *   - storage fallback when a layer is unavailable
 *   - 30-minute inactivity session rotation (with injectable clock)
 *   - `reset()` default + `{ anonymous: false }` semantics
 *   - `identify()` updates `customer_id` and leaves the anonymous link
 *     intact for the next event (the authoritative `anonymous_id +
 *     customer_id` overlap)
 *   - identity persistence across a simulated page reload
 *   - WebView detection surfaces in diagnostics
 *   - degraded environments record the right diagnostic flags
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IdentityManager } from "../src/identity/manager.js";
import type { StorageLayer } from "../src/types.js";
import { clearAllCookies } from "./helpers/dom.js";

function clearAllStorage(): void {
  clearAllCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
}

beforeEach(() => clearAllStorage());
afterEach(() => clearAllStorage());

describe("IdentityManager — capability detection", () => {
  it("lands on cookie when document.cookie is available", () => {
    const mgr = new IdentityManager();
    const cap = mgr.getCapability();
    expect(cap.primary).toBe("cookie");
    expect(cap.available).toContain("cookie");
    expect(cap.degraded).toBe(false);
  });

  it("records degraded=true when only sessionStorage or memory is available", () => {
    const mgr = new IdentityManager({
      storageOrder: ["sessionStorage", "memory"],
      document: undefined,
      window,
    });
    const cap = mgr.getCapability();
    expect(["sessionStorage", "memory"]).toContain(cap.primary);
    expect(cap.degraded).toBe(true);
  });

  it("falls forward to memory when nothing else is wired", () => {
    const mgr = new IdentityManager({
      storageOrder: ["memory"],
      document: undefined,
      window: undefined,
    });
    const cap = mgr.getCapability();
    expect(cap.primary).toBe("memory");
    expect(cap.degraded).toBe(true);
  });

  it("seeds anon_/sess_ identifiers when no record is stored", () => {
    const mgr = new IdentityManager();
    expect(mgr.getAnonymousId()).toMatch(/^anon_/);
    expect(mgr.getSessionId()).toMatch(/^sess_/);
    expect(mgr.getCustomerId()).toBeNull();
  });

  it("diagnostics surface the current storage layer and last activity timestamp", () => {
    let now = 1_700_000_000_000;
    const mgr = new IdentityManager({ now: () => now });
    const before = mgr.getDiagnostics();
    expect(before.currentLayer).toBe("cookie");
    expect(before.lastActivityAt).toBe(now);
    now += 1_000;
    mgr.touch();
    const after = mgr.getDiagnostics();
    expect(after.lastActivityAt).toBe(now);
  });
});

describe("IdentityManager — identify / reset semantics", () => {
  it("identify attaches customer_id and preserves the anonymous link", () => {
    const mgr = new IdentityManager();
    const anonBefore = mgr.getAnonymousId();
    const sessBefore = mgr.getSessionId();
    mgr.identify("cus_123");
    expect(mgr.getCustomerId()).toBe("cus_123");
    expect(mgr.getAnonymousId()).toBe(anonBefore);
    expect(mgr.getSessionId()).toBe(sessBefore);
  });

  it("identify rejects empty customer_id", () => {
    const mgr = new IdentityManager();
    expect(() => mgr.identify("")).toThrowError(/non-empty/);
  });

  it("reset rotates session and anonymous by default and clears customer", () => {
    const mgr = new IdentityManager();
    const anonBefore = mgr.getAnonymousId();
    const sessBefore = mgr.getSessionId();
    mgr.identify("cus_123");
    mgr.reset();
    expect(mgr.getCustomerId()).toBeNull();
    expect(mgr.getAnonymousId()).not.toBe(anonBefore);
    expect(mgr.getSessionId()).not.toBe(sessBefore);
  });

  it("reset({ anonymous: false }) keeps anonymous identity, rotates session, clears customer", () => {
    const mgr = new IdentityManager();
    const anonBefore = mgr.getAnonymousId();
    const sessBefore = mgr.getSessionId();
    mgr.identify("cus_456");
    mgr.reset({ anonymous: false });
    expect(mgr.getCustomerId()).toBeNull();
    expect(mgr.getAnonymousId()).toBe(anonBefore);
    expect(mgr.getSessionId()).not.toBe(sessBefore);
  });

  it("forced rotateSession rotates without crossing the inactivity threshold", () => {
    const now = 1_700_000_000_000;
    const mgr = new IdentityManager({ now: () => now });
    const sessBefore = mgr.getSessionId();
    mgr.rotateSession();
    expect(mgr.getSessionId()).not.toBe(sessBefore);
  });
});

describe("IdentityManager — session inactivity rotation", () => {
  it("does not rotate inside the inactivity window", () => {
    let now = 1_700_000_000_000;
    const mgr = new IdentityManager({
      now: () => now,
      sessionInactivityMs: 30 * 60 * 1000,
    });
    const sessBefore = mgr.getSessionId();
    // 29 minutes later
    now += 29 * 60 * 1000;
    mgr.touch();
    expect(mgr.getSessionId()).toBe(sessBefore);
  });

  it("rotates session_id after 30 minutes of inactivity", () => {
    let now = 1_700_000_000_000;
    const mgr = new IdentityManager({
      now: () => now,
      sessionInactivityMs: 30 * 60 * 1000,
    });
    const sessBefore = mgr.getSessionId();
    // jump past the threshold
    now += 30 * 60 * 1000 + 1;
    expect(mgr.getSessionId()).not.toBe(sessBefore);
  });

  it("touch resets the inactivity clock so consecutive activity does not rotate", () => {
    let now = 1_700_000_000_000;
    const mgr = new IdentityManager({
      now: () => now,
      sessionInactivityMs: 30 * 60 * 1000,
    });
    const sessBefore = mgr.getSessionId();
    for (let i = 0; i < 5; i += 1) {
      now += 20 * 60 * 1000; // 20 minutes, well under the threshold
      mgr.touch();
    }
    expect(mgr.getSessionId()).toBe(sessBefore);
  });

  it("hydrates a stored identity and rotates if it is already past the threshold", () => {
    // First instance writes identity at t=0.
    let now = 1_700_000_000_000;
    const first = new IdentityManager({ now: () => now });
    const sessBefore = first.getSessionId();
    const anonBefore = first.getAnonymousId();

    // Simulate page reload: keep cookie state (the happy-dom document
    // persists between IdentityManager instances in this test scope) but
    // advance the clock past the threshold.
    now += 31 * 60 * 1000;
    const second = new IdentityManager({ now: () => now });
    expect(second.getAnonymousId()).toBe(anonBefore);
    expect(second.getSessionId()).not.toBe(sessBefore);
  });
});

describe("IdentityManager — persistence across simulated reloads", () => {
  it("anonymous_id survives a fresh IdentityManager construction", () => {
    const first = new IdentityManager();
    const anon = first.getAnonymousId();
    const second = new IdentityManager();
    expect(second.getAnonymousId()).toBe(anon);
  });

  it("customer_id survives a fresh IdentityManager construction", () => {
    const first = new IdentityManager();
    first.identify("cus_789");
    const second = new IdentityManager();
    expect(second.getCustomerId()).toBe("cus_789");
  });

  it("reset clears state across reloads (customer is no longer present)", () => {
    const first = new IdentityManager();
    first.identify("cus_999");
    first.reset();
    const second = new IdentityManager();
    expect(second.getCustomerId()).toBeNull();
  });

  it("anonymous_id mirrors into localStorage so cookie eviction survives", () => {
    const first = new IdentityManager();
    const anon = first.getAnonymousId();
    expect(first.getCapability().primary).toBe("cookie");
    // Cookie is the canonical layer, localStorage is the mirror — the
    // architecture doc requires the anonymous_id to be mirrored into
    // localStorage when available so identity survives a Safari ITP
    // cookie eviction.
    const mirror = window.localStorage.getItem("polaris_id");
    expect(mirror).not.toBeNull();
    expect(mirror).toContain(anon);
  });

  it("simulated cookie eviction falls back to the localStorage mirror", () => {
    const first = new IdentityManager();
    const anon = first.getAnonymousId();
    clearAllCookies();
    // localStorage still has the record; a fresh instance should hydrate.
    const second = new IdentityManager();
    expect(second.getAnonymousId()).toBe(anon);
  });
});

describe("IdentityManager — WebView / degraded environment detection", () => {
  it("flags WebView=true when the navigator user-agent looks like Instagram", () => {
    const originalUA = window.navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Instagram 250.0.0.21.109",
    });
    try {
      const mgr = new IdentityManager();
      expect(mgr.getCapability().webview).toBe(true);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => originalUA,
      });
    }
  });

  it("flags WebView=true when the user-agent contains the Android wv marker", () => {
    const originalUA = window.navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      get: () =>
        "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36",
    });
    try {
      const mgr = new IdentityManager();
      expect(mgr.getCapability().webview).toBe(true);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => originalUA,
      });
    }
  });

  it("flags WebView=false for a vanilla Chrome user-agent", () => {
    const originalUA = window.navigator.userAgent;
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      get: () =>
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    });
    try {
      const mgr = new IdentityManager();
      expect(mgr.getCapability().webview).toBe(false);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        get: () => originalUA,
      });
    }
  });

  it("records degraded=true when the primary layer is memory only", () => {
    const mgr = new IdentityManager({
      storageOrder: ["memory"],
      document: undefined,
      window: undefined,
    });
    expect(mgr.getCapability().degraded).toBe(true);
    expect(mgr.getCapability().primary).toBe("memory");
  });
});

describe("IdentityManager — toEnvelopeIdentity()", () => {
  it("returns envelope-shaped identity with device_id=null", () => {
    const mgr = new IdentityManager();
    mgr.identify("cus_envelope");
    const env = mgr.toEnvelopeIdentity();
    expect(env.anonymous_id).toMatch(/^anon_/);
    expect(env.session_id).toMatch(/^sess_/);
    expect(env.customer_id).toBe("cus_envelope");
    expect(env.device_id).toBeNull();
  });

  it("envelope-shaped identity rotates session if inactivity threshold crossed", () => {
    let now = 1_700_000_000_000;
    const mgr = new IdentityManager({ now: () => now });
    const before = mgr.toEnvelopeIdentity();
    now += 31 * 60 * 1000;
    const after = mgr.toEnvelopeIdentity();
    expect(after.session_id).not.toBe(before.session_id);
  });
});

describe("IdentityManager — invalid configuration", () => {
  it("rejects a non-positive sessionInactivityMs", () => {
    expect(() => new IdentityManager({ sessionInactivityMs: 0 })).toThrowError(
      /sessionInactivityMs/,
    );
    expect(() => new IdentityManager({ sessionInactivityMs: -1 })).toThrowError(
      /sessionInactivityMs/,
    );
  });

  it("respects an injected id generator for deterministic tests", () => {
    let counter = 0;
    const idGenerator: (prefix: "anon" | "sess") => string = (prefix) => `${prefix}_${++counter}`;
    const mgr = new IdentityManager({ idGenerator });
    expect(mgr.getAnonymousId()).toBe("anon_1");
    expect(mgr.getSessionId()).toBe("sess_2");
  });

  it("custom storageOrder is honoured", () => {
    const order: readonly StorageLayer[] = ["sessionStorage", "memory"];
    const mgr = new IdentityManager({ storageOrder: order });
    expect(["sessionStorage", "memory"]).toContain(mgr.getCapability().primary);
  });
});
