/**
 * `make geoip-refresh` writes the file the enrichment stage reads.
 *
 * The database is provisioned by one command and consumed by another, and
 * the two agree on a path through two separate defaults: the Makefile's
 * `POLARIS_GEOIP_DB_PATH` and the shell default baked into the stage's
 * `dev` script. Nothing else connects them. Move either and the fetch
 * still succeeds, the stage still boots, and geo silently reads
 * `no_lookup` forever — the exact symptom this whole wiring exists to end,
 * reintroduced by a rename.
 *
 * A smoke rather than a unit test, per the card: what is being checked is
 * a Make target and a script, not a function. Nothing here fetches
 * anything — that needs a MaxMind licence key and the network, and neither
 * belongs in a gate.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE_DIR = join(ROOT, "sync", "enrichment", "runtime", "v1");

/** The Makefile's default destination, as a path relative to the repo root. */
function makefileDefault(): string {
  const source = readFileSync(join(ROOT, "Makefile"), "utf8");
  const match = /^POLARIS_GEOIP_DB_PATH \?= \$\(CURDIR\)\/(\S+)$/m.exec(source);
  if (match === null) throw new Error("no POLARIS_GEOIP_DB_PATH default in the Makefile");
  return match[1] as string;
}

/**
 * The path `bin/setup`'s receipt checks for, relative to the repo root.
 *
 * A third copy of one location, and the one most likely to rot: it is only
 * ever read to decide whether to print a hint, so getting it wrong produces
 * no error — just a receipt that nags about a database already installed,
 * or stays silent about one that never was.
 */
function setupReceiptDefault(): string {
  const source = readFileSync(join(ROOT, "bin", "setup"), "utf8");
  const match = /const DEFAULT_GEOIP_DB_PATH = resolve\(REPO_ROOT, "([^"]+)"\)/.exec(source);
  if (match === null) throw new Error("bin/setup names no geoip database default");
  return match[1] as string;
}

/**
 * The stage's default, as a path relative to the repo root.
 *
 * Read out of the `dev` script rather than imported, because the shell
 * default IS the wiring: `${VAR:-...}` is what lets `.env.local` override
 * it while a developer who set nothing still gets a working stack.
 */
function devScriptDefault(): string {
  const pkg = JSON.parse(readFileSync(join(STAGE_DIR, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const match = /\$\{POLARIS_SYNC_ENRICHMENT_GEOIP_DB_PATH:-([^}]+)\}/.exec(
    pkg.scripts["dev"] ?? "",
  );
  if (match === null) throw new Error("the dev script names no geoip database default");
  // pnpm runs the script from the package directory, so the default is
  // resolved against that — not against the repo root.
  return relative(ROOT, resolve(STAGE_DIR, match[1] as string));
}

/** The recipe `make` would run, without running it. */
function dryRun(...overrides: string[]): string {
  return execFileSync("make", ["-n", "geoip-refresh", ...overrides], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

describe("make geoip-refresh", () => {
  it("writes the file the enrichment stage reads", () => {
    // The one assertion this file exists for.
    expect(devScriptDefault()).toBe(makefileDefault());
  });

  it("is the same file `make setup` checks for before nagging about it", () => {
    expect(setupReceiptDefault()).toBe(makefileDefault());
  });

  it("lands the database somewhere git refuses to commit", () => {
    // MaxMind's licence forbids redistributing the file. A default path
    // that is not ignored puts a 60 MB licence violation one `git add -A`
    // away, and the commit that did it would look routine.
    const target = join(ROOT, makefileDefault());
    const ignored = execFileSync("git", ["check-ignore", "-q", target], {
      cwd: ROOT,
      encoding: "utf8",
      // `check-ignore` exits 1 for a path that is NOT ignored, which is
      // the failure being tested, not an error running the command.
    });
    expect(ignored).toBe("");
  });

  it("hands the script an absolute destination", () => {
    // The stage runs from `sync/enrichment/runtime/v1` under `make dev`. A
    // relative destination here would be written against the repo root and
    // read against the package directory — two different files, one name,
    // and a boot warning pointing at a path that looks correct.
    const recipe = dryRun();
    const match = /POLARIS_GEOIP_DB_PATH="([^"]*)"/.exec(recipe);
    expect(match).not.toBeNull();
    expect(isAbsolute((match?.[1] as string) ?? "")).toBe(true);
  });

  it("passes both variables explicitly, not through the .env.local export", () => {
    // The Makefile's blanket `export` sits inside the `.env.local`
    // conditional, so on a machine without that file it does not run and
    // nothing would reach the script.
    const recipe = dryRun();
    expect(recipe).toContain("POLARIS_GEOIP_LICENSE_KEY=");
    expect(recipe).toContain("./infra/geoip/refresh-geoip.sh");
  });

  it("lets an operator redirect the destination", () => {
    // `?=`, so a value already set — by `.env.local`, which is `include`d
    // above it, or on the command line — wins over the default.
    expect(dryRun("POLARIS_GEOIP_DB_PATH=/srv/elsewhere/City.mmdb")).toContain(
      'POLARIS_GEOIP_DB_PATH="/srv/elsewhere/City.mmdb"',
    );
  });
});

describe("the refresh script", () => {
  it("refuses without a licence key instead of installing nothing quietly", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "polaris-geoip-")), "GeoLite2-City.mmdb");
    let stderr = "";
    let status = 0;
    try {
      execFileSync(join(ROOT, "infra", "geoip", "refresh-geoip.sh"), {
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"] ?? "",
          POLARIS_GEOIP_DB_PATH: dest,
          POLARIS_GEOIP_LICENSE_KEY: "",
        },
      });
    } catch (err) {
      const failure = err as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }
    // It dies on the missing key before it reaches the network, so this
    // asserts a refusal and never a download.
    expect(status).toBeGreaterThan(0);
    expect(stderr).toContain("POLARIS_GEOIP_LICENSE_KEY is required");
  });
});
