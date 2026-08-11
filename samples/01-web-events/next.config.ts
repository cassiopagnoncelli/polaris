import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The Polaris SDKs are consumed through a `link:` dependency that points at
 * `packages/web-sdk` inside this monorepo, so the real module lives above
 * this app's directory. Pinning the root at the repo root keeps Turbopack
 * and the build-time file tracer from guessing (and warning about the two
 * lockfiles they can see).
 *
 * A real application installing `@polaris/web-sdk` from the internal
 * registry needs none of this file.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // `next dev` writes AGENTS.md / CLAUDE.md into the app directory by
  // default. This repo keeps its agent instructions in `agents/AGENTS.md`,
  // so the samples opt out rather than scatter more of them around.
  agentRules: false,
};

export default nextConfig;
