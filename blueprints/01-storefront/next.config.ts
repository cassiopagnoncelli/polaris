import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The Polaris SDKs are consumed through `link:` dependencies pointing at
 * `sdks/web` and `sdks/node` inside this monorepo, so the real modules live
 * above this app's directory. Pinning the root at the repo root keeps
 * Turbopack and the build-time file tracer from guessing (and warning about
 * the two lockfiles they can see).
 *
 * A real application installing `@polaris/web-sdk` and `@polaris/node-sdk`
 * from the internal registry needs none of this file.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * There is deliberately no API-key handling here.
 *
 * `make setup` writes the tokens it issues to `.env.development.local` and
 * `.env.production.local`, which Next loads ahead of `.env.local` on its own.
 * A freshly issued token therefore outranks a hand-pasted one by the
 * framework's documented precedence, which is what we want — `make setup`
 * drops the old keys as it issues new ones, so a pasted copy goes stale and a
 * stale token does not announce itself, it just 401s.
 *
 * Both modes, because that precedence is mode-scoped and this app runs both
 * ways: `pnpm dev`, and `pnpm build && pnpm start`.
 *
 * This file used to parse `blueprints/api-key` and assign into `process.env`
 * to force that outcome, warning whenever it overwrote something. It worked,
 * but it inverted the precedence every Next developer already knows, so the
 * inversion needed a warning to explain itself, and the warning fired on
 * every boot at the developer who had done exactly what the README said. The
 * ordering was never the problem; hand-rolling it was.
 */
const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // `next dev` writes AGENTS.md / CLAUDE.md into the app directory by
  // default. This repo keeps its agent instructions in `agents/AGENTS.md`,
  // so the blueprint opts out rather than scatter more of them around.
  agentRules: false,
};

export default nextConfig;
