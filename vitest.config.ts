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
      // ADR-0007's six-kind roots. `definitions/**` is live: 0DIPB moved
      // `catalog/` under it, and those packages are workspace members whose
      // contents are enforcement inputs rather than documentation, so their
      // registries carry tests like any package. The other three still match
      // nothing, exactly as in `pnpm-workspace.yaml`: both epochs are
      // collected at once so that each move card is a pure `git mv`, and
      // IJ4NN deletes the `packages/**` line once nothing is left behind it.
      //
      // A root missing from this list does not fail — the tests under it are
      // simply never collected, and a suite that runs nothing is the one
      // failure a green gate cannot catch. That is what made this file, rather
      // than the moves it serves, the thing to fix first.
      "libs/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "sdks/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "connectors/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "definitions/**/*.{test,spec}.?(c|m)[jt]s?(x)",
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
        // The same six-kind roots, so a moved package keeps being measured as
        // well as collected. `definitions/` inherited `catalog/`'s flat shape —
        // a registry is `definitions/traits/*.ts`, not a `src/` tree — because
        // 0DIPB renamed the directory rather than restructuring it.
        "libs/**/src/**",
        "sdks/**/src/**",
        "connectors/**/src/**",
        "definitions/*/*.ts",
      ],
      exclude: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "**/test/**", "**/dist/**", "**/build/**"],
    },
  },
});
