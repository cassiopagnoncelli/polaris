import { describe, expect, it } from "vitest";

import { ExitCode, type OutputStreams, type PackageMeta, run } from "../src/index.js";

interface Capture {
  readonly streams: OutputStreams;
  readonly stdout: string[];
  readonly stderr: string[];
}

function captureOutput(): Capture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

const META: PackageMeta = {
  version: "0.0.0-test",
  gitSha: "deadbeef",
  buildTime: "2026-05-12T00:00:00.000Z",
  releaseLabel: undefined,
  nodeVersion: "v22.0.0",
};

const VALID_ENV = {
  POLARIS_API_URL: "https://polaris.example.internal",
  POLARIS_TOKEN: "polaris_ot_test",
} as const;

describe("run / polaris version", () => {
  it("prints the version block in human mode", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["version"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const out = capture.stdout.join("");
    expect(out).toContain("polaris 0.0.0-test");
    expect(out).toContain("node v22.0.0");
    expect(out).toContain("sha deadbeef");
    expect(out).toContain("built 2026-05-12T00:00:00.000Z");
  });

  it("prints structured JSON when --output json is passed", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["--output", "json", "version"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const out = capture.stdout.join("");
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({
      name: "polaris",
      version: "0.0.0-test",
      node: "v22.0.0",
      git_sha: "deadbeef",
      build_time: "2026-05-12T00:00:00.000Z",
    });
  });

  it("runs `version` successfully even with no auth env vars set", async () => {
    // v1 CLI commands are DATABASE_URL-direct; POLARIS_TOKEN / POLARIS_API_URL
    // are required only at the HTTP boundary (none ship in v1). loadCliConfig
    // therefore returns a nullable config on a fresh shell, and non-HTTP
    // commands like `version` succeed.
    const capture = captureOutput();
    const code = await run({
      argv: ["version"],
      env: {},
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
  });

  it("returns exit code 2 on an unknown command", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["definitely-not-a-real-command"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.UsageError);
  });

  it("returns exit code 0 for --help", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["--help"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("Polaris control-plane CLI");
    expect(help).toContain("POLARIS_API_URL");
    expect(help).toContain("POLARIS_TOKEN");
    expect(help).toContain("POLARIS_PROFILE");
    expect(help).toContain("--profile");
    expect(help).toContain("Exit codes:");
  });

  it("returns exit code 0 for --version (commander built-in)", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["--version"],
      env: { ...VALID_ENV },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(capture.stdout.join("")).toContain("0.0.0-test");
  });

  it("never echoes the bearer token to stdout or stderr", async () => {
    const capture = captureOutput();
    await run({
      argv: ["version"],
      env: {
        POLARIS_API_URL: "https://polaris.example.internal",
        POLARIS_TOKEN: "polaris_ot_SECRET_VALUE_42",
      },
      output: capture.streams,
      meta: META,
    });
    const combined = capture.stdout.join("") + capture.stderr.join("");
    expect(combined).not.toContain("polaris_ot_SECRET_VALUE_42");
  });

  it("gives a subcommand's own --version to the subcommand, not the CLI version", async () => {
    // Regression: commander matches a root option ANYWHERE in argv unless
    // positional options are enabled, so `processors enable x --version v1`
    // used to hit the root's `-v, --version`, print the CLI version, and exit
    // 0 without ever touching the activation row. Every runner-level test
    // passed because none of them went through argv.
    //
    // The command must get far enough to fail on something LATER than parsing
    // — here, the absent DATABASE_URL — which proves the flag reached it.
    const capture = captureOutput();
    const code = await run({
      argv: [
        "processors",
        "enable",
        "sync-identity-resolver",
        "--version",
        "v1",
        "--project",
        "storefront",
        "--env",
        "development",
      ],
      env: {},
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.ConfigError);
    const combined = capture.stdout.join("") + capture.stderr.join("");
    expect(combined).not.toContain("0.0.0-test");
    expect(combined).toContain("DATABASE_URL");
  });

  it("accepts a global flag before or after the subcommand", async () => {
    // Enabling positional options is what stops the root from swallowing
    // `--version`; re-declaring the globals per command is what keeps
    // `polaris <cmd> --output json` — the form the ops runbooks use — working.
    for (const argv of [
      ["version", "--output", "json"],
      ["--output", "json", "version"],
    ]) {
      const capture = captureOutput();
      const code = await run({
        argv,
        env: { ...VALID_ENV },
        output: capture.streams,
        meta: META,
      });
      expect(code, argv.join(" ")).toBe(ExitCode.Ok);
      expect(JSON.parse(capture.stdout.join("")), argv.join(" ")).toMatchObject({
        name: "polaris",
        version: "0.0.0-test",
      });
    }
  });

  it("emits a JSON-formatted error envelope when POLARIS_OUTPUT=json", async () => {
    // Trigger a real config error (malformed URL) so the JSON envelope shape
    // gets exercised. The "missing token / api-url" path no longer reaches
    // here because v1 commands don't require either at parse time.
    const capture = captureOutput();
    const code = await run({
      argv: ["version"],
      env: {
        POLARIS_OUTPUT: "json",
        POLARIS_API_URL: "ftp://oops",
        POLARIS_TOKEN: "tok",
      },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.ConfigError);
    const parsed = JSON.parse(capture.stderr.join(""));
    expect(parsed.error).toBe("ConfigError");
    expect(parsed.code).toBe(ExitCode.ConfigError);
  });
});
