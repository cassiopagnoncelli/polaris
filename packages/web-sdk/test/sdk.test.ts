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
