/**
 * Silent session-refresh tests.
 *
 * Two things are being pinned here. First that an expired session recovers
 * in place rather than bouncing the operator through Idp mid-form. Second —
 * and this is the one that would be a real bug — that concurrent requests
 * finding the same expired token redeem the refresh token exactly **once**.
 * Idp rotates refresh tokens on redemption, so a second concurrent redemption
 * gets `invalid_grant` and can clobber the winner's fresh cookie with a dead
 * one. A page load plus its stylesheet is enough to hit that.
 */

import type { RefreshResult } from "@polaris/auth";
import { RefreshError } from "@polaris/auth";
import { describe, expect, it, vi } from "vitest";

import { wrapSingleFlight } from "../src/admin/refresh.js";

function tokens(suffix: string): RefreshResult {
  return {
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresIn: 900,
    tokenType: "Bearer",
  };
}

describe("session refresh — single flight", () => {
  it("redeems a refresh token once for concurrent callers, and gives all of them the result", async () => {
    let resolveRedeem: ((value: RefreshResult) => void) | undefined;
    const redeem = vi.fn(
      () =>
        new Promise<RefreshResult>((resolve) => {
          resolveRedeem = resolve;
        }),
    );
    const refresher = wrapSingleFlight(redeem);

    const first = refresher.refresh("refresh-old");
    const second = refresher.refresh("refresh-old");
    const third = refresher.refresh("refresh-old");

    expect(redeem).toHaveBeenCalledTimes(1);
    resolveRedeem?.(tokens("new"));

    for (const result of await Promise.all([first, second, third])) {
      expect(result).toEqual({ ok: true, tokens: tokens("new") });
    }
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce different refresh tokens", async () => {
    const redeem = vi.fn(async (token: string) => tokens(token));
    const refresher = wrapSingleFlight(redeem);
    await Promise.all([refresher.refresh("a"), refresher.refresh("b")]);
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("does not cache the result — a rotated token must never be replayed", async () => {
    const redeem = vi.fn(async () => tokens("new"));
    const refresher = wrapSingleFlight(redeem);
    await refresher.refresh("refresh-old");
    await refresher.refresh("refresh-old");
    // Two sequential calls are two redemptions. Coalescing is for concurrency
    // only; caching would hand out a retired grant.
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight slot after a failure so a later attempt can retry", async () => {
    const redeem = vi
      .fn<(token: string) => Promise<RefreshResult>>()
      .mockRejectedValueOnce(new RefreshError("boom", 503, "network_error"))
      .mockResolvedValueOnce(tokens("new"));
    const refresher = wrapSingleFlight(redeem);

    expect(await refresher.refresh("refresh-old")).toEqual({ ok: false, reason: "transient" });
    expect(await refresher.refresh("refresh-old")).toEqual({ ok: true, tokens: tokens("new") });
  });

  it("separates a dead grant from a blip, because only one of them needs a fresh login", async () => {
    const invalid = wrapSingleFlight(async () => {
      throw new RefreshError("revoked", 400, "invalid_grant");
    });
    expect(await invalid.refresh("x")).toEqual({ ok: false, reason: "invalid_grant" });

    const timeout = wrapSingleFlight(async () => {
      throw new RefreshError("timeout", 502, "network_error");
    });
    expect(await timeout.refresh("x")).toEqual({ ok: false, reason: "transient" });

    const serverError = wrapSingleFlight(async () => {
      throw new RefreshError("idp down", 503, "server_error");
    });
    expect(await serverError.refresh("x")).toEqual({ ok: false, reason: "transient" });
  });

  it("treats a non-RefreshError throw as transient rather than crashing the guard", async () => {
    const refresher = wrapSingleFlight(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await refresher.refresh("x")).toEqual({ ok: false, reason: "transient" });
  });
});
