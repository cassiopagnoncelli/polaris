import { defineConfig } from "vitest/config";

// Dedicated Vitest config for repo-root scripts/.
//
// The root vitest.config.ts scans the six-kind tree roots and tests/ -- not
// scripts/. (It said `processors/` and `consumers/` until
// 2026-08-19; those directories were retired by the R-programme move and
// deleted.) Scripts that live at the repository root (CI helpers, workspace
// lints) ship their tests next to the script under scripts/__tests__/, and
// `pnpm test:scripts` (package.json) targets this config.
//
// Not a substitute for the workspace test suite: what belongs here is a
// check ABOUT the repository -- that a dashboard names a family that
// exists, that a manifest agrees with the code it describes -- rather than
// a test of any one package's behaviour.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/fixtures/**"],
    reporters: ["default"],
  },
});
