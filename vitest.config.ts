import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "apps/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "processors/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "consumers/**/*.{test,spec}.?(c|m)[jt]s?(x)",
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
        "processors/**/src/**",
        "consumers/**/src/**",
      ],
      exclude: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "**/test/**", "**/dist/**", "**/build/**"],
    },
  },
});
