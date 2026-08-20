// @vitest-environment happy-dom
/**
 * Cookie storage layer — first-party cookie identity persistence.
 *
 * Verifies the doctrinal cookie behaviour from `10-sdk-standards.md`:
 *   - `SameSite=Lax` by default
 *   - `Secure` set when the page is served over HTTPS
 *   - cookie domain configurable for subdomain sharing
 *   - cookie name configurable, defaults to `polaris_id`
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CookieStore } from "../src/identity/cookie-store.js";
import type { PersistedIdentity } from "../src/types.js";
import { clearAllCookies, setRawCookie } from "./helpers/dom.js";

function makeIdentity(overrides: Partial<PersistedIdentity> = {}): PersistedIdentity {
  return {
    anonymous_id: "anon_test",
    session_id: "sess_test",
    customer_id: null,
    last_activity_at: 1_700_000_000_000,
    storage_layer: "cookie",
    ...overrides,
  };
}

describe("CookieStore", () => {
  beforeEach(() => clearAllCookies());
  afterEach(() => clearAllCookies());

  it("reports as available when document.cookie works", () => {
    const store = new CookieStore({ document, secureContext: false });
    expect(store.isAvailable()).toBe(true);
  });

  it("reports unavailable when no document is provided", () => {
    const store = new CookieStore({ document: undefined, secureContext: false });
    expect(store.isAvailable()).toBe(false);
  });

  it("round-trips a write and a read", () => {
    const store = new CookieStore({ document, secureContext: false });
    const identity = makeIdentity({ anonymous_id: "anon_round_trip" });
    expect(store.write(identity)).toBe(true);
    const got = store.read();
    expect(got?.anonymous_id).toBe("anon_round_trip");
    expect(got?.session_id).toBe("sess_test");
    expect(got?.customer_id).toBeNull();
  });

  it("uses the configured cookie name", () => {
    const store = new CookieStore({
      document,
      options: { name: "polaris_alt" },
      secureContext: false,
    });
    expect(store.write(makeIdentity())).toBe(true);
    // The alt cookie carries the encoded JSON payload; the default name
    // is either absent or only present as the empty residue some test
    // DOMs leave behind after a Max-Age=0 clear. The contract here is
    // that the configured name (`polaris_alt`) is where reads find the
    // payload, not the default.
    expect(store.read()?.anonymous_id).toBe("anon_test");
    const defaultStore = new CookieStore({ document, secureContext: false });
    expect(defaultStore.read()).toBeNull();
  });

  it("clears the cookie", () => {
    const store = new CookieStore({ document, secureContext: false });
    store.write(makeIdentity());
    expect(store.read()).not.toBeNull();
    expect(store.clear()).toBe(true);
    expect(store.read()).toBeNull();
  });

  it("returns null on malformed cookie payload", () => {
    setRawCookie("polaris_id=not-json; Path=/; Max-Age=60; SameSite=Lax");
    const store = new CookieStore({ document, secureContext: false });
    expect(store.read()).toBeNull();
  });

  it("returns null on partial payload (missing field)", () => {
    const partial = encodeURIComponent(JSON.stringify({ anonymous_id: "x", session_id: "y" }));
    setRawCookie(`polaris_id=${partial}; Path=/; Max-Age=60; SameSite=Lax`);
    const store = new CookieStore({ document, secureContext: false });
    expect(store.read()).toBeNull();
  });

  describe("attributes", () => {
    /**
     * happy-dom does not let us read back the attributes of a cookie via
     * `document.cookie`. We assert against the same write path by
     * intercepting the `document.cookie` setter through a Proxy on a
     * synthetic document. This keeps the contract test honest without
     * adding a browser harness.
     */
    function captureCookieSetters(): { writes: string[]; doc: Document } {
      const writes: string[] = [];
      const stub: Document = new Proxy({} as Document, {
        get(_t, prop) {
          if (prop === "cookie") return writes.length === 0 ? "" : writes[writes.length - 1];
          return undefined;
        },
        set(_t, prop, value: string) {
          if (prop === "cookie") writes.push(value);
          return true;
        },
      });
      return { writes, doc: stub };
    }

    it("writes SameSite=Lax by default", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({ document: doc, secureContext: false });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("SameSite=Lax");
    });

    it("writes Secure when secureContext is true", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({ document: doc, secureContext: true });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("Secure");
    });

    it("omits Secure on HTTP and honours an explicit override", () => {
      const { writes, doc } = captureCookieSetters();
      // No secureContext, but explicit `secure: true` is honoured.
      const store = new CookieStore({
        document: doc,
        secureContext: false,
        options: { secure: true },
      });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("Secure");

      // Reverse: HTTPS context but caller pinned `secure: false`.
      const { writes: writes2, doc: doc2 } = captureCookieSetters();
      const store2 = new CookieStore({
        document: doc2,
        secureContext: true,
        options: { secure: false },
      });
      store2.write(makeIdentity());
      const lastWrite2 = writes2[writes2.length - 1] ?? "";
      expect(lastWrite2).not.toContain("Secure");
    });

    it("writes the configured Domain attribute when set", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({
        document: doc,
        secureContext: false,
        options: { domain: ".example.com" },
      });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("Domain=.example.com");
    });

    it("omits Domain when not set (browser scopes to current host)", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({ document: doc, secureContext: false });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).not.toContain("Domain=");
    });

    it("writes SameSite=Strict when configured", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({
        document: doc,
        secureContext: true,
        options: { sameSite: "Strict" },
      });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("SameSite=Strict");
    });

    it("writes a configurable Max-Age", () => {
      const { writes, doc } = captureCookieSetters();
      const store = new CookieStore({
        document: doc,
        secureContext: false,
        options: { maxAgeSeconds: 3600 },
      });
      store.write(makeIdentity());
      const lastWrite = writes[writes.length - 1] ?? "";
      expect(lastWrite).toContain("Max-Age=3600");
    });
  });
});
