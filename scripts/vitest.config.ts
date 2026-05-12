import { defineConfig } from "vitest/config";

// Dedicated Vitest config for repo-root scripts/.
//
// The root vitest.config.ts only scans apps/, packages/, processors/, and
// consumers/. Scripts that live at the repository root (CI helpers,
// workspace lints) ship their tests next to the script under scripts/__tests__/,
// and `pnpm test:scripts` (package.json) targets this config.
//
// Kept narrow on purpose: this config only covers the lint-clickhouse-imports
// script and any future repo-root scripts the CI workflow runs. It is not
// a substitute for the workspace test suite.
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "**/fixtures/**"],
    reporters: ["default"],
  },
});
