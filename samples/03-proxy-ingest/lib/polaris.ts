"use client";

import { PolarisWebSdk } from "@polaris/web-sdk";

/**
 * Same Web SDK as samples/01, pointed at this app's own origin.
 *
 * Two differences worth noticing:
 *
 *   - the endpoint is a relative path, so every request is same-origin: no
 *     preflight, no allow-list row, nothing for a blocker to match on a
 *     third-party host
 *   - `apiKey` is a placeholder. The transport requires a non-empty string
 *     and sends it as `x-polaris-api-key`, but the relay replaces that
 *     header with the real key. Nothing secret ships to the browser.
 *
 * Page-exit flushes can use `navigator.sendBeacon` here — beacons cannot set
 * headers, which breaks a direct-to-ingester setup, but this relay
 * authenticates on the server so there is no header to lose.
 */

let instance: Promise<PolarisWebSdk> | undefined;

export function getPolaris(): Promise<PolarisWebSdk> {
  if (instance === undefined) {
    instance = PolarisWebSdk.create({
      endpoint: "/api/polaris/events",
      apiKey: "relayed-by-the-server",
      source: { id: "storefront-web" },
    });
  }
  return instance;
}
