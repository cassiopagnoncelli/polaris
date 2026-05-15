/**
 * SDK version stamped into `source.sdk_version` on every event by default.
 *
 * Auto-read from the package.json this module is published with so the value
 * matches the npm version operators see in their dependency tree. Falls back
 * to `0.0.0` only when the package.json cannot be resolved (e.g. an unusual
 * bundler shaving away `import.meta.url`); the fallback is logged so the
 * mismatch is visible.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadSdkVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // src/internal/version.ts -> ../../package.json
    // Built variant: dist/internal/version.js -> ../../package.json
    const pkgPath = join(dirname(here), "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to fallback.
  }
  return "0.0.0-unknown";
}

export const SDK_VERSION: string = loadSdkVersion();
