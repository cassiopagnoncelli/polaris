import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, DEFAULT_CONFIG_PATH, loadCliConfig, readConfigFile } from "../src/index.js";

describe("loadCliConfig", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "polaris-cli-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the default profile when env vars are set", () => {
    const config = loadCliConfig({
      env: {
        POLARIS_API_URL: "https://polaris.example.internal",
        POLARIS_TOKEN: "polaris_ot_abc",
      },
      configFile: join(tmp, "missing.toml"),
    });
    expect(config.profile).toBe("default");
    expect(config.apiUrl).toBe("https://polaris.example.internal");
    expect(config.token).toBe("polaris_ot_abc");
    expect(config.tokenEnvName).toBe("POLARIS_TOKEN");
    expect(config.output).toBe("human");
    expect(config.logLevel).toBe("warn");
    expect(config.configFilePath).toBeUndefined();
  });

  it("strips trailing slash from the API URL", () => {
    const config = loadCliConfig({
      env: {
        POLARIS_API_URL: "https://polaris.example.internal/",
        POLARIS_TOKEN: "tok",
      },
      configFile: join(tmp, "missing.toml"),
    });
    expect(config.apiUrl).toBe("https://polaris.example.internal");
  });

  it("rejects missing POLARIS_TOKEN", () => {
    expect(() =>
      loadCliConfig({
        env: { POLARIS_API_URL: "https://polaris.example.internal" },
        configFile: join(tmp, "missing.toml"),
      }),
    ).toThrow(ConfigError);
  });

  it("rejects missing POLARIS_API_URL when no profile is selected", () => {
    expect(() =>
      loadCliConfig({
        env: { POLARIS_TOKEN: "tok" },
        configFile: join(tmp, "missing.toml"),
      }),
    ).toThrow(/POLARIS_API_URL is required/);
  });

  it("rejects an API URL with a non-http scheme", () => {
    expect(() =>
      loadCliConfig({
        env: { POLARIS_API_URL: "ftp://oops/", POLARIS_TOKEN: "tok" },
        configFile: join(tmp, "missing.toml"),
      }),
    ).toThrow(/http:\/\/ or https:\/\//);
  });

  it("resolves a profile from the TOML file", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        "[profiles.production]",
        'url = "https://polaris.example.internal"',
        'token_env = "POLARIS_PROD_TOKEN"',
        "",
        "[profiles.staging]",
        'url = "https://polaris-staging.example.internal"',
        'token_env = "POLARIS_STAGING_TOKEN"',
      ].join("\n"),
    );
    const config = loadCliConfig({
      profile: "production",
      env: { POLARIS_PROD_TOKEN: "prod_tok" },
      configFile: path,
    });
    expect(config.profile).toBe("production");
    expect(config.apiUrl).toBe("https://polaris.example.internal");
    expect(config.token).toBe("prod_tok");
    expect(config.tokenEnvName).toBe("POLARIS_PROD_TOKEN");
    expect(config.configFilePath).toBe(path);
  });

  it("reads POLARIS_PROFILE when --profile is not given", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        "[profiles.staging]",
        'url = "https://staging.example"',
        'token_env = "POLARIS_STAGING_TOKEN"',
      ].join("\n"),
    );
    const config = loadCliConfig({
      env: { POLARIS_PROFILE: "staging", POLARIS_STAGING_TOKEN: "stg" },
      configFile: path,
    });
    expect(config.profile).toBe("staging");
    expect(config.token).toBe("stg");
  });

  it("falls back to default_profile from the file", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        'default_profile = "staging"',
        "[profiles.staging]",
        'url = "https://staging.example"',
        'token_env = "POLARIS_STAGING_TOKEN"',
      ].join("\n"),
    );
    const config = loadCliConfig({
      env: { POLARIS_STAGING_TOKEN: "stg" },
      configFile: path,
    });
    expect(config.profile).toBe("staging");
  });

  it("rejects an unknown profile name", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        "[profiles.production]",
        'url = "https://polaris.example.internal"',
        'token_env = "POLARIS_PROD_TOKEN"',
      ].join("\n"),
    );
    expect(() =>
      loadCliConfig({
        profile: "missing",
        env: {},
        configFile: path,
      }),
    ).toThrow(/profile "missing" is not defined/);
  });

  it("rejects missing token env var declared by a profile", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        "[profiles.production]",
        'url = "https://polaris.example.internal"',
        'token_env = "POLARIS_PROD_TOKEN"',
      ].join("\n"),
    );
    expect(() =>
      loadCliConfig({
        profile: "production",
        env: {},
        configFile: path,
      }),
    ).toThrow(/POLARIS_PROD_TOKEN is required/);
  });

  it("rejects unknown TOML top-level keys", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(path, 'token = "should not be here"');
    expect(() => readConfigFile(path)).toThrow(ConfigError);
  });

  it("rejects token plaintext in a profile entry", () => {
    const path = join(tmp, "config.toml");
    writeFileSync(
      path,
      [
        "[profiles.production]",
        'url = "https://polaris.example.internal"',
        'token = "polaris_ot_NEVER_STORE_THIS"',
      ].join("\n"),
    );
    expect(() => readConfigFile(path)).toThrow(/unrecognized key|unknown key/i);
  });

  it("honours POLARIS_LOG_LEVEL", () => {
    const config = loadCliConfig({
      env: {
        POLARIS_API_URL: "https://polaris.example.internal",
        POLARIS_TOKEN: "tok",
        POLARIS_LOG_LEVEL: "debug",
      },
      configFile: join(tmp, "missing.toml"),
    });
    expect(config.logLevel).toBe("debug");
  });

  it("falls back to warn for an unrecognised POLARIS_LOG_LEVEL", () => {
    const config = loadCliConfig({
      env: {
        POLARIS_API_URL: "https://polaris.example.internal",
        POLARIS_TOKEN: "tok",
        POLARIS_LOG_LEVEL: "loud",
      },
      configFile: join(tmp, "missing.toml"),
    });
    expect(config.logLevel).toBe("warn");
  });
});

describe("DEFAULT_CONFIG_PATH", () => {
  it("points at ~/.polaris/config.toml", () => {
    expect(DEFAULT_CONFIG_PATH).toMatch(/\.polaris[\\/]config\.toml$/);
  });
});
