import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_ENVIRONMENTS,
  deploymentEnvironmentSchema,
  isPolarisEnvironment,
  POLARIS_ENVIRONMENTS,
  polarisEnvironmentSchema,
  rowEnvironmentFor,
} from "../src/index.js";

describe("POLARIS_ENVIRONMENTS", () => {
  it("is exactly the three row environments, in canonical order", () => {
    expect([...POLARIS_ENVIRONMENTS]).toEqual(["development", "staging", "production"]);
  });

  it("rejects `test` — no environment-checked table accepts it", () => {
    expect(polarisEnvironmentSchema.safeParse("test").success).toBe(false);
  });

  it("rejects `local` — that is a deployment label, not a row value", () => {
    expect(polarisEnvironmentSchema.safeParse("local").success).toBe(false);
  });

  it("accepts each member", () => {
    for (const environment of POLARIS_ENVIRONMENTS) {
      expect(polarisEnvironmentSchema.safeParse(environment).success).toBe(true);
    }
  });
});

describe("DEPLOYMENT_ENVIRONMENTS", () => {
  /**
   * The load-bearing test: it is what makes drift between the two sets
   * impossible. Widening the row set without widening the deployment set (or
   * vice versa) fails here rather than in production.
   */
  it("is exactly the row environments plus `local`", () => {
    expect([...DEPLOYMENT_ENVIRONMENTS]).toEqual(["local", ...POLARIS_ENVIRONMENTS]);
  });

  it("accepts `local`", () => {
    expect(deploymentEnvironmentSchema.safeParse("local").success).toBe(true);
  });

  it("rejects `test`", () => {
    expect(deploymentEnvironmentSchema.safeParse("test").success).toBe(false);
  });
});

describe("isPolarisEnvironment", () => {
  it("narrows members", () => {
    expect(isPolarisEnvironment("production")).toBe(true);
  });

  it("rejects non-members and non-strings", () => {
    expect(isPolarisEnvironment("test")).toBe(false);
    expect(isPolarisEnvironment("local")).toBe(false);
    expect(isPolarisEnvironment(undefined)).toBe(false);
    expect(isPolarisEnvironment(3)).toBe(false);
  });
});

describe("rowEnvironmentFor", () => {
  it("maps a local deployment onto development", () => {
    // The one translation that matters: `local` is a deployment environment
    // and no `environment` column accepts it.
    expect(rowEnvironmentFor("local")).toBe("development");
  });

  it("keeps a deployment that is already a row environment", () => {
    for (const env of POLARIS_ENVIRONMENTS) {
      expect(rowEnvironmentFor(env)).toBe(env);
    }
  });

  it("points anything unrecognised at development, never production", () => {
    for (const bad of ["", "test", "prod", "PRODUCTION"]) {
      expect(rowEnvironmentFor(bad)).toBe("development");
    }
  });
});
