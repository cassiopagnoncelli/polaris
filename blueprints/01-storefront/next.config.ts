import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The Polaris SDKs are consumed through `link:` dependencies pointing at
 * `packages/web-sdk` and `packages/node-sdk` inside this monorepo, so the
 * real modules live above this app's directory. Pinning the root at the repo
 * root keeps Turbopack and the build-time file tracer from guessing (and
 * warning about the two lockfiles they can see).
 *
 * A real application installing `@polaris/web-sdk` and `@polaris/node-sdk`
 * from the internal registry needs none of this file.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Read the tokens `bin/setup` issued, for any that `.env.local` leaves unset.
 *
 * `make setup` drops the database and reissues these on every run, so a
 * token pasted into `.env.local` by hand goes stale the next time anyone
 * runs it — and a stale token does not announce itself, it just makes every
 * request 401. Reading the generated file instead means a fresh install
 * needs no copying: restart the blueprint and it has working keys.
 *
 * `.env.local` still wins where it sets a value. It holds the developer's
 * choices — which transport to start on, whether direct mode is on at all —
 * and a generated file has no business overruling those.
 *
 * `NEXT_PUBLIC_POLARIS_API_KEY` is deliberately NOT filled in from here.
 * Setting it inlines a key into the JS bundle, which is a decision about
 * what is publishable, and it is the decision this blueprint exists to
 * teach. Wiring it automatically would make that choice silently, on
 * everyone's behalf, which is the opposite of the lesson. See `.env.example`.
 */
function loadIssuedKeys(): void {
  const keyFile = resolve(repoRoot, "blueprints/api-key");
  if (!existsSync(keyFile)) return;

  for (const line of readFileSync(keyFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    if (process.env[name] === undefined || process.env[name] === "") {
      process.env[name] = trimmed.slice(separator + 1).trim();
    }
  }
}

loadIssuedKeys();

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // `next dev` writes AGENTS.md / CLAUDE.md into the app directory by
  // default. This repo keeps its agent instructions in `agents/AGENTS.md`,
  // so the blueprint opts out rather than scatter more of them around.
  agentRules: false,
};

export default nextConfig;
