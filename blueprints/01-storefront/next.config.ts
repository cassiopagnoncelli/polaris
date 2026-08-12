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
 * Take the API tokens from the file `bin/setup` generates.
 *
 * The split is value versus choice. `blueprints/api-key` owns the *value* of
 * a token, because the command that writes it is the same command that
 * invalidated every older one. `.env.local` owns the *choices* — which
 * transport a fresh browser starts on, and whether direct mode is enabled at
 * all — and nothing here touches those.
 *
 * This file therefore wins over `.env.local` for the two token variables,
 * which is the opposite of the usual precedence and is deliberate. The first
 * cut had `.env.local` win where it set a value, and that reproduced the
 * exact failure the generated file exists to prevent: `make setup` reissues
 * the keys, the token someone once pasted into `.env.local` keeps winning,
 * and every request 401s with `unknown_key` until they think to look. A
 * stale credential is not a preference worth honouring.
 *
 * `NEXT_PUBLIC_POLARIS_API_KEY` is the careful case. Setting it inlines a
 * token into the JS bundle, which is a decision about what is publishable —
 * the decision this blueprint exists to teach — so an empty value stays
 * empty and the app runs relay-only. But once a developer has put something
 * there they have already made that call, and refreshing it to the current
 * web token keeps their choice working rather than making a new one.
 */
function loadIssuedKeys(): void {
  const keyFile = resolve(repoRoot, "blueprints/api-key");
  if (!existsSync(keyFile)) return;

  const issued = new Map<string, string>();
  for (const line of readFileSync(keyFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    issued.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  for (const [name, token] of issued) {
    apply(name, token);
  }

  // Direct mode only: refresh a token the developer opted into, never
  // introduce one they did not.
  const webToken = issued.get("POLARIS_WEB_API_KEY");
  if (webToken !== undefined && (process.env["NEXT_PUBLIC_POLARIS_API_KEY"] ?? "") !== "") {
    apply("NEXT_PUBLIC_POLARIS_API_KEY", webToken);
  }
}

/** Set `name`, saying so when it replaces a different non-empty value. */
function apply(name: string, token: string): void {
  const current = process.env[name] ?? "";
  if (current === token) return;
  if (current !== "") {
    console.warn(
      `[polaris] ${name} in .env.local is not the token blueprints/api-key holds — ` +
        "using the issued one. `make setup` reissues keys, which makes any pasted " +
        "copy stale; delete the line from .env.local to silence this.",
    );
  }
  process.env[name] = token;
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
