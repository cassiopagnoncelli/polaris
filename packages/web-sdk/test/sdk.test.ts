// @vitest-environment happy-dom
/**
 * `PolarisWebSdk` — public-surface stub.
 *
 * P3-002 ships identity only. This test verifies the public surface
 * matches `docs/architecture/10-sdk-standards.md`:
 *
 *   - `identify(customerId, traits?)`
 *   - `reset(options?)`
 *   - `track(event, properties)` exists but is not implemented (P3-003)
 *   - `flush()` exists but is not implemented (P3-003)
 *
 * The identity-side wiring delegates to `IdentityManager`, which has
 * its own exhaustive test suite. This file checks the surface contract.
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
    const sdk = new PolarisWebSdk();
    const cap = sdk.getCapability();
    expect(cap.primary).toBeTypeOf("string");
    const env = sdk.getEnvelopeIdentity();
    expect(env.anonymous_id).toMatch(/^anon_/);
    expect(env.session_id).toMatch(/^sess_/);
    expect(env.customer_id).toBeNull();
  });

  it("identify and reset flow through to the identity manager", () => {
    const sdk = new PolarisWebSdk();
    sdk.identify("cus_42");
    expect(sdk.getEnvelopeIdentity().customer_id).toBe("cus_42");
    sdk.reset();
    expect(sdk.getEnvelopeIdentity().customer_id).toBeNull();
  });

  it("getIdentityManager exposes the underlying manager for diagnostics", () => {
    const sdk = new PolarisWebSdk();
    const mgr = sdk.getIdentityManager();
    expect(mgr.getCapability().primary).toBe(sdk.getCapability().primary);
  });

  it("diagnostics surfaces the storage layer", () => {
    const sdk = new PolarisWebSdk();
    const diag = sdk.getDiagnostics();
    expect(diag.currentLayer).toBe(sdk.getCapability().primary);
  });
});

describe("PolarisWebSdk — P3-003 placeholders", () => {
  it("track() rejects with a descriptive error until P3-003 lands", async () => {
    const sdk = new PolarisWebSdk();
    await expect(sdk.track("page.viewed", {})).rejects.toThrowError(/P3-003/);
  });

  it("flush() rejects with a descriptive error until P3-003 lands", async () => {
    const sdk = new PolarisWebSdk();
    await expect(sdk.flush()).rejects.toThrowError(/P3-003/);
  });
});
