import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultSchemaBindings, type EventCatalog, loadCatalogFromDir } from "@polaris/spec";

/**
 * Wrapper around the file-backed event catalog loader.
 *
 * The catalog is **file-backed** by design (`docs/instructions/claude.md`
 * "File-Heavy, DB-Light"): YAML metadata under `definitions/events/**` plus
 * code-backed Zod schemas registered in `defaultSchemaBindings`. This
 * helper resolves the on-disk root once at startup and merges the two
 * pieces into a runtime `EventCatalog` the ingester handler queries on
 * every event.
 *
 * The handler **must not** mutate or reload this catalog at runtime —
 * schema evolution is a deploy-time concern (per `01-event-contract.md`
 * "Schema Governance"). Reloading would also race with in-flight events.
 */

/** Resolve the default `definitions/events/` root for this repository layout. */
export function resolveDefaultCatalogRoot(): string {
  // `import.meta.url` points at this file under `apps/ingester-api/src/`.
  // The catalog root lives at the worktree root, four directories up.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "definitions", "events");
}

/**
 * Load the runtime catalog. Throws on startup if the YAML or the bindings
 * are inconsistent — services must allow the throw to crash the process.
 *
 * The default `bindings` come from `@polaris/spec`. Tests may
 * pass a custom set when validating against fixture events.
 */
export function loadRuntimeCatalog(
  options: {
    readonly catalogRoot?: string;
    readonly bindings?: Parameters<typeof loadCatalogFromDir>[1];
  } = {},
): EventCatalog {
  const root = options.catalogRoot ?? resolveDefaultCatalogRoot();
  const bindings = options.bindings ?? defaultSchemaBindings;
  return loadCatalogFromDir(root, bindings);
}
