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

  it("returns exit code 3 with a config error when POLARIS_TOKEN is missing", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["version"],
      env: { POLARIS_API_URL: "https://polaris.example.internal" },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.ConfigError);
    expect(capture.stderr.join("")).toContain("POLARIS_TOKEN is required");
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

  it("emits a JSON-formatted error envelope when POLARIS_OUTPUT=json", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["version"],
      env: { POLARIS_OUTPUT: "json" },
      output: capture.streams,
      meta: META,
    });
    expect(code).toBe(ExitCode.ConfigError);
    const parsed = JSON.parse(capture.stderr.join(""));
    expect(parsed.error).toBe("ConfigError");
    expect(parsed.code).toBe(ExitCode.ConfigError);
  });
});
