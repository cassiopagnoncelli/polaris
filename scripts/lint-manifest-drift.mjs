/**
 * A manifest may not lie about which streams its unit reads and writes.
 *
 * Every processor and consumer ships a manifest declaring `inputs` and
 * `outputs` as stream families. Nothing read them. A manifest could name
 * a family the code never touches, or omit one it does, and no test,
 * type, or lint would notice — the manifest is documentation the runtime
 * never consults.
 *
 * That is not hypothetical. The resolver published to three families and
 * its wiring passed no isolation lookup, so it threw on every event; the
 * ClickHouse sink grew a routing branch for `rejected.events` and no
 * subscription; `rejected.events` itself reached no broker for a day.
 * A manifest is the one artifact that states the intent those three
 * violated, and it was inert.
 *
 * ## How the families are found
 *
 * By reading the source for `STREAM_FAMILY_*` at USE sites, not by
 * importing the modules: importing every unit would mean building the
 * workspace to run a lint, and a lint that needs a build is one that gets
 * skipped. Two patterns carry direction:
 *
 *   consumerFamiliesFor(STREAM_FAMILY_X   -> input
 *   subscribe({ families: [...X...]       -> input
 *   family: STREAM_FAMILY_X               -> output
 *   inputFamily: STREAM_FAMILY_X          -> input
 *
 * Import lines and comments are stripped first, so a family that only
 * appears in an import or a sentence is not counted as wiring.
 *
 * ## What it does NOT do
 *
 * It does not make the wiring manifest-DRIVEN. The manifest stays
 * documentation; this asserts the documentation is true. Making the
 * runtime read families from YAML is a much larger change and was
 * explicitly out of scope.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");
const UNIT_ROOTS = ["sync", "async"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", "test"]);

/**
 * `STREAM_FAMILY_RAW_EVENTS` -> `raw.events`.
 *
 * Derived from the constant's own name rather than imported, for the same
 * reason the scan is textual. The mapping is mechanical: strip the
 * prefix, lowercase, and the single underscore left is the dot.
 */
export function familyFromConstant(name) {
  const bare = name.replace(/^STREAM_FAMILY_/, "").toLowerCase();
  const index = bare.lastIndexOf("_");
  return index < 0 ? bare : `${bare.slice(0, index)}.${bare.slice(index + 1)}`;
}

/** Strip line comments, block comments and import statements. */
export function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import\s[\s\S]*?from\s+"[^"]+";/gm, "");
}

/**
 * Families a unit's source actually wires, split by direction.
 *
 * A family appearing only in a `const OUTPUT_STREAM_FAMILY = X` binding
 * counts as neither: the binding is a rename, and the use site it feeds
 * is what this looks for.
 */
export function wiredFamilies(source) {
  const body = strip(source);
  const inputs = new Set();
  const outputs = new Set();

  for (const match of body.matchAll(/consumerFamiliesFor\(\s*(STREAM_FAMILY_[A-Z_]+)/g)) {
    inputs.add(familyFromConstant(match[1]));
  }
  for (const match of body.matchAll(/inputFamily:\s*\[?\s*(STREAM_FAMILY_[A-Z_]+)/g)) {
    inputs.add(familyFromConstant(match[1]));
  }
  // A list-valued `inputFamily` names more than one.
  for (const match of body.matchAll(/inputFamily:\s*\[([^\]]*)\]/g)) {
    for (const inner of match[1].matchAll(/STREAM_FAMILY_[A-Z_]+/g)) {
      inputs.add(familyFromConstant(inner[0]));
    }
  }
  for (const match of body.matchAll(/\bfamil(?:y|ies):\s*\[?\s*(STREAM_FAMILY_[A-Z_]+)/g)) {
    outputs.add(familyFromConstant(match[1]));
  }
  // A family both consumed and produced is an input; the `family:` form
  // appears inside `subscribe({ families })` too.
  for (const family of inputs) outputs.delete(family);
  return { inputs, outputs };
}

/**
 * State stores a manifest declares, e.g. `redis:sessions`.
 *
 * Checked as well as families because the drift this card was written for
 * was a state store: sessionizer v1 declared `memory:sessions` and shipped
 * a Redis one. A manifest is what an operator reads to know which
 * dependencies a processor needs running, and that one said "none".
 */
export function declaredStores(yaml) {
  const stores = new Set();
  let inSection = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^state_stores:/.test(line)) {
      inSection = true;
      continue;
    }
    if (/^[a-z_]+:/.test(line)) {
      inSection = false;
      continue;
    }
    const match = /^\s*-\s*"?([a-z]+:[a-z_]+)"?/.exec(line);
    if (match !== null && inSection) stores.add(match[1]);
  }
  return stores;
}

/**
 * Whether the source reaches for Redis at all.
 *
 * Detected through the config schema rather than the word "redis": a
 * comment mentioning Redis is not a dependency, and `redisEnvSchema` in a
 * config module is exactly the thing that makes one.
 */
export function usesRedis(source) {
  return /\bredisEnvSchema\b/.test(strip(source));
}

/** Families a manifest declares, split by direction. */
export function declaredFamilies(yaml) {
  const declared = { inputs: new Set(), outputs: new Set() };
  let section = null;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^inputs:/.test(line)) {
      section = "inputs";
      continue;
    }
    if (/^outputs:/.test(line)) {
      section = "outputs";
      continue;
    }
    if (/^[a-z_]+:/.test(line)) {
      section = null;
      continue;
    }
    if (section === null) continue;
    // Two shapes in the wild, both valid:
    //   - family: raw.events      (processors, with schema_versions)
    //   - resolved.events         (destinations, bare)
    // A parser handling only the first reported all five destinations as
    // drifted when none of them was — six false positives, which is how a
    // check teaches people to ignore it.
    const keyed = /^\s*-?\s*family:\s*"?([a-z][a-z.]*)"?/.exec(line);
    if (keyed !== null) {
      declared[section].add(keyed[1]);
      continue;
    }
    const bare = /^\s*-\s*"?([a-z][a-z.]*\.[a-z]+)"?\s*$/.exec(line);
    if (bare !== null) declared[section].add(bare[1]);
  }
  return declared;
}

function walkSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function findManifests(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".manifest.yaml")) found.push(full);
    }
  };
  for (const unitRoot of UNIT_ROOTS) walk(join(root, unitRoot));
  return found.sort();
}

/**
 * A unit's manifest test must load its OWN version.
 *
 * sessionizer v2's test was copied from v1 and kept `version: "v1"`, so it
 * asserted v1's manifest twice and v2's never — while sitting in v2's
 * directory, reading exactly like coverage. Its assertions could claim
 * `raw.events` and `memory:sessions` and still pass, because both were
 * true of the file it was actually loading.
 *
 * The check is a string comparison between the directory's version
 * segment and the version argument, which is all it needs to be.
 */
function findManifestTestDrift(root, unitDir) {
  const problems = [];
  const version = unitDir.split("/").pop();
  for (const file of walkTests(join(unitDir, "test"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/loadProcessorManifest\(\{[^}]*version:\s*"(v\d+)"/gs)) {
      if (match[1] !== version) {
        problems.push({
          file: relative(root, file),
          reason:
            `loads manifest version "${match[1]}" while living in ${version} — ` +
            `it is asserting another unit's manifest, and ${version}'s is untested`,
        });
      }
    }
  }
  return problems;
}

function walkTests(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTests(full, out);
    else if (full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

export function findDrift(root = DEFAULT_ROOT) {
  const problems = [];
  for (const manifestPath of findManifests(root)) {
    const unitDir = dirname(manifestPath);
    const source = walkSources(join(unitDir, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    if (source.length === 0) continue;

    const yaml = readFileSync(manifestPath, "utf8");
    problems.push(...findManifestTestDrift(root, unitDir));
    const declared = declaredFamilies(yaml);
    const wired = wiredFamilies(source);
    const rel = relative(root, manifestPath);

    const stores = declaredStores(yaml);
    const redis = usesRedis(source);
    const claimsRedis = [...stores].some((store) => store.startsWith("redis:"));
    if (redis && !claimsRedis) {
      problems.push({
        file: rel,
        reason:
          "reads redisEnvSchema but declares no `redis:` state store — an operator " +
          "reading this manifest would not know Redis has to be running",
      });
    }
    if (!redis && claimsRedis) {
      problems.push({
        file: rel,
        reason: "declares a `redis:` state store the source never configures",
      });
    }

    for (const [direction, decl, wire] of [
      ["inputs", declared.inputs, wired.inputs],
      ["outputs", declared.outputs, wired.outputs],
    ]) {
      for (const family of decl) {
        if (!wire.has(family)) {
          problems.push({
            file: rel,
            reason: `declares ${direction} \`${family}\`, which the source never wires`,
          });
        }
      }
      for (const family of wire) {
        if (!decl.has(family)) {
          problems.push({
            file: rel,
            reason: `wires ${direction} \`${family}\`, which the manifest does not declare`,
          });
        }
      }
    }
  }
  return problems;
}

function main() {
  const problems = findDrift();
  if (problems.length > 0) {
    console.error(
      `manifest-drift check: ${String(problems.length)} manifest claim(s) do not match`,
    );
    console.error("the wiring. A manifest is the only artifact stating a unit's intent.\n");
    for (const problem of problems) {
      console.error(`  ${problem.file}\n    ${problem.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("manifest-drift check: every manifest matches the families its source wires.");
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
