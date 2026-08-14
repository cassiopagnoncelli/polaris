// @vitest-environment happy-dom
/**
 * `PolarisWebSdk` — public-surface tests for the identity layer.
 *
 * The track / flush / lifecycle tests for P3-003 live in
 * `test/web-sdk.test.ts` (the larger suite that exercises the full
 * queue + transport + retry + lifecycle path).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PolarisWebSdk } from "../src/sdk.js";
import { clearAllCookies } from "./helpers/dom.js";

beforeEach(() => {
  clearAllCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  clearAllCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("PolarisWebSdk — identity surface", () => {
  it("exposes capability detection and a default identity", () => {
    const sdk = new PolarisWebSdk({
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const cap = sdk.getCapability();
    expect(cap.primary).toBeTypeOf("string");
    const env = sdk.getEnvelopeIdentity();
    expect(env.anonymous_id).toMatch(/^anon_/);
    expect(env.session_id).toMatch(/^sess_/);
    expect(env.customer_id).toBeNull();
  });

  it("identify and reset flow through to the identity manager", () => {
    const sdk = new PolarisWebSdk({
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    sdk.identify("cus_42");
    expect(sdk.getEnvelopeIdentity().customer_id).toBe("cus_42");
    sdk.reset();
    expect(sdk.getEnvelopeIdentity().customer_id).toBeNull();
  });

  it("identify emits user.identified carrying the traits, with identity already set", async () => {
    // The co-occurrence of anonymous_id and customer_id ON this event is
    // what lets the resolver bind both to one profile. Identity is set
    // before the event is built for exactly that reason.
    const sent: Array<{ event: string; properties: unknown; customer: string | null }> = [];
    const sdk = new PolarisWebSdk({
      transport: {
        send: async (events) => {
          for (const e of events) {
            sent.push({
              event: e.event,
              properties: e.properties,
              customer: e.identity.customer_id,
            });
          }
          return acceptAll(events);
        },
      },
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const anonymousBefore = sdk.getEnvelopeIdentity().anonymous_id;

    sdk.identify("cus_42", { tier: "gold" });
    await sdk.flush();

    const identified = sent.find((e) => e.event === "user.identified");
    expect(identified).toBeDefined();
    expect(identified?.properties).toEqual({ tier: "gold" });
    expect(identified?.customer).toBe("cus_42");
    expect(sdk.getEnvelopeIdentity().anonymous_id).toBe(anonymousBefore);
  });

  it("identify without traits emits empty properties and never throws", async () => {
    const sdk = new PolarisWebSdk({
      transport: { send: async (e) => acceptAll(e) },
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    expect(() => sdk.identify("cus_42")).not.toThrow();
    await sdk.flush();
  });

  it("getIdentityManager exposes the underlying manager for diagnostics", () => {
    const sdk = new PolarisWebSdk({
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const mgr = sdk.getIdentityManager();
    expect(mgr.getCapability().primary).toBe(sdk.getCapability().primary);
  });

  it("diagnostics surfaces the storage layer", () => {
    const sdk = new PolarisWebSdk({
      startupEagerFlushWindowMs: 0,
      steadyFlushIntervalMs: 0,
      flushOnPagehide: false,
    });
    const diag = sdk.getDiagnostics();
    expect(diag.currentLayer).toBe(sdk.getCapability().primary);
  });
});
