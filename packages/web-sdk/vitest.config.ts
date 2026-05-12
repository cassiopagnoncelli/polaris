import { defineConfig } from "vitest/config";

/**
 * Web SDK uses the `happy-dom` Vitest environment for the identity-persistence
 * tests. happy-dom is lighter than jsdom and gives us `document.cookie`,
 * `window.localStorage`, `window.sessionStorage`, and `navigator.userAgent`
 * which is everything the identity layer needs. Cookie / storage tests
 * exercise the same code paths a real browser uses.
 *
 * No DOM environment is needed in production at runtime — the SDK runs in
 * real browsers — but we need one in tests so capability detection and
 * fallback behaviour can be exercised without a headless browser harness.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: "happy-dom",
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)", "src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
    reporters: ["default"],
    clearMocks: true,
    restoreMocks: true,
  },
});
