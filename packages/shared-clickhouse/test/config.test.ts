import { describe, expect, it } from "vitest";
import { ClickHouseConfigError, parseClickHouseConfig } from "../src/index.js";

describe("parseClickHouseConfig", () => {
  const valid = {
    url: "http://localhost:8123",
    role: "service" as const,
    credential: { username: "polaris_service", password: "p" },
  };

  it("accepts a minimal valid service config", () => {
    const cfg = parseClickHouseConfig(valid);
    expect(cfg.role).toBe("service");
    expect(cfg.application).toBe("polaris");
    expect(cfg.url).toBe("http://localhost:8123");
  });

  it("accepts a minimal valid operator config", () => {
    const cfg = parseClickHouseConfig({
      ...valid,
      role: "operator" as const,
      credential: { username: "polaris_operator", password: "p" },
    });
    expect(cfg.role).toBe("operator");
  });

  it("refuses to parse when role is missing", () => {
    const input = { ...valid } as Record<string, unknown>;
    delete input.role;
    expect(() => parseClickHouseConfig(input)).toThrow(ClickHouseConfigError);
    expect(() => parseClickHouseConfig(input)).toThrow(/role/i);
  });

  it("refuses to parse when role is empty string", () => {
    expect(() => parseClickHouseConfig({ ...valid, role: "" })).toThrow(ClickHouseConfigError);
  });

  it("refuses to parse when role is null", () => {
    expect(() => parseClickHouseConfig({ ...valid, role: null })).toThrow(ClickHouseConfigError);
  });

  it("refuses unknown roles", () => {
    expect(() =>
      parseClickHouseConfig({ ...valid, role: "admin" as unknown as "service" }),
    ).toThrow(ClickHouseConfigError);
  });

  it("refuses non-http URLs", () => {
    expect(() => parseClickHouseConfig({ ...valid, url: "tcp://localhost:9000" })).toThrow(
      ClickHouseConfigError,
    );
  });

  it("refuses an empty credential", () => {
    expect(() =>
      parseClickHouseConfig({ ...valid, credential: { username: "", password: "p" } }),
    ).toThrow(ClickHouseConfigError);
    expect(() =>
      parseClickHouseConfig({
        ...valid,
        credential: { username: "u", password: "" },
      }),
    ).toThrow(ClickHouseConfigError);
  });

  it("refuses a non-object input", () => {
    expect(() => parseClickHouseConfig(null)).toThrow(ClickHouseConfigError);
    expect(() => parseClickHouseConfig("hello")).toThrow(ClickHouseConfigError);
    expect(() => parseClickHouseConfig(123)).toThrow(ClickHouseConfigError);
  });
});
