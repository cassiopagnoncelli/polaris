import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "apps/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "sync/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "async/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      // Catalog packages (`catalog/traits`, `catalog/policy`) are
      // workspace members whose contents are enforcement inputs, not
      // documentation — their registries carry tests like any package.
      "catalog/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      // Repo-root integration / smoke tests (see P5-001). Each test
      // file inside tests/smoke/ is expected to gate on its own
      // env var (e.g. POLARIS_SMOKE_DOCKER=1) so the default
      // `pnpm test` stays Docker-free.
      "tests/**/*.{test,spec}.?(c|m)[jt]s?(x)",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: [
        "apps/**/src/**",
        "packages/**/src/**",
        "sync/**/src/**",
        "async/**/src/**",
        "catalog/*/*.ts",
      ],
      exclude: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "**/test/**", "**/dist/**", "**/build/**"],
    },
  },
});
