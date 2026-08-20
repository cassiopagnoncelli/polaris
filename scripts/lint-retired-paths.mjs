#!/usr/bin/env node
// Polaris retired-path check.
//
// Nothing in this repository may point at a directory the R-programme move
// deleted, or teach the pipeline model it replaced.
//
// ## Why a check and not a careful sweep
//
// The move happened in `f9ae3d0` and the docs pass that followed edited the
// files somebody remembered. A conformance audit later found the rest: four
// documents still teaching `raw.events -> versioned processors -> derived
// topics`, one of them asserting the retired rule and its replacement in the
// same section, and roughly fifty references to `processors/<name>/v<n>/` and
// `consumers/<vendor>/v<n>/` across prose, module headers and CLI help.
//
// A reader cannot tell a stale sentence from a current one. The CLI help was
// the sharpest case: `polaris destinations --help` told an operator where
// mapper code lives, and the path it named had not existed for a day.
//
// So the sweep is not the fix — this is. A sentence that names a dead
// directory now fails a gate rather than waiting for the next audit.
//
// ## What it looks for
//
// Two things, both stated as literal patterns rather than inferred:
//
//   1. RETIRED PATHS — `processors/<name>/...`, `consumers/<vendor>/...`,
//      `catalog/<kind>/`, `sql/` and `db/migrations/` as a repository
//      location. Units live under `{sync,async}/<stage>/`; declared content
//      lives under `definitions/`; storage DDL lives under `db/<engine>/`.
//   2. RETIRED MODEL — the fan-out prose. Processors no longer read
//      `raw.events` in parallel and emit sibling derived events; the spine
//      chains, and enrichment lands IN the envelope.
//
// ## What it deliberately does not do
//
// It does not read English. A file may discuss the retired model as history
// — `definitions/events/enriched/geoip.v1.yaml` explains what `enriched.events`
// WAS, and the redesign plan records the before/after — and those are the
// most useful pages on the subject. Such a file is listed in `HISTORICAL`
// with its reason, which is the same shape as every other exception list
// here: an entry is a claim that the mention is deliberately about the past.
//
// Run it as:
//
//   node scripts/lint-retired-paths.mjs
//
// Set POLARIS_RETIRED_PATH_ROOT to scan a fixture tree (used by the test).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, "..");

/** Directories worth scanning. Everything else is generated or vendored. */
const SCAN_DIRS = [
  ".github",
  "apps",
  "async",
  // ADR-0007's remaining destination. Matches nothing until P9J7X creates it;
  // listed now so the card that fills it cannot forget the gate.
  "connectors",
  "db",
  "definitions",
  "docs",
  "infra",
  // ADR-0007 destination for the libraries `packages/` held. Absent, a moved
  // page stops being scanned and its stale sentence survives the move.
  "libs",
  "packages",
  "scripts",
  // The SDK tier, listed when ZXBDY moved the two SDKs out of `packages/`.
  // A root this check does not name is not a root it reports clean; it is one
  // it never opens, and the whole point of a gate over prose is that a stale
  // sentence cannot be told from a current one by reading it.
  "sdks",
  "sync",
  "tests",
];

/** Files at the repository root that are read before anything else is. */
const ROOT_FILES = ["README.md", "AGENTS.md", "Makefile"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  "tsconfig.tsbuildinfo",
  // Applied migrations are immutable by policy and are a RECORD of what was
  // true when they ran. `20260818000001_retire_fan_out_topic_families.sql` is
  // the migration that deleted the families; naming them is its subject.
  // Editing one to satisfy a lint would be falsifying the history the file
  // exists to keep.
  "migrations",
  // Accepted ADRs, for the same reason. ADR-0005 names
  // `processors/sessionizer/v1/src/store.ts` because that is where the file
  // was when the decision was made; the record is of the decision, not of
  // the current tree. Superseding is how an ADR changes, not editing.
  "adr",
]);

const SCANNED_EXT = new Set([
  ".md",
  ".ts",
  ".mts",
  ".mjs",
  ".js",
  ".yaml",
  ".yml",
  ".json",
  ".sql",
]);

/**
 * The patterns, each with the replacement a reader needs.
 *
 * `hint` is the whole value of this check: a file that fails should not send
 * anybody to `git log` to find out what the path became.
 */
/**
 * Where ADR-0007 sent the platform libraries.
 *
 * The move is a directory move only — `@polaris/shared-db` still resolves,
 * because pnpm resolves by package NAME and the names do not change until
 * IJ4NN. What stops resolving is the PATH, and a path is what documentation,
 * runbooks, dashboards and module headers point with. So the same argument
 * that produced this file applies again: a sentence naming
 * `packages/shared-db/` is now naming a directory that does not exist, and a
 * reader cannot tell it from a current one.
 *
 * Keyed by old path so the hint can name the exact destination rather than
 * telling everybody to go and read the ADR. The thirteen packages still under
 * `packages/` are deliberately absent — they have not moved, and IJ4NN is the
 * card that retires the location itself.
 *
 * What this cannot see: a path built from segments rather than written out,
 * `join(ROOT, "packages", "shared-transport", "src", "streams.ts")`. Two script
 * tests were exactly that and this rule was blind to both; the suite caught
 * them by opening the file and failing on ENOENT. Widening the pattern to
 * chase quoted segments would trade a class of false negatives for a class of
 * false positives, so the division stands: prose and literal paths here, real
 * reads in the tests that do them.
 */
const MOVED_LIBRARIES = new Map([
  ["shared-transport", "libs/bus"],
  ["shared-processor", "libs/pipeline"],
  ["shared-db", "libs/persistence/postgres"],
  ["shared-clickhouse", "libs/persistence/clickhouse"],
  ["shared-control-plane-db", "libs/persistence/control-plane"],
  ["shared-logger", "libs/observability/logger"],
  ["shared-metrics", "libs/observability/metrics"],
  ["shared-service-bootstrap", "libs/runtime/service-bootstrap"],
  ["shared-config", "libs/runtime/config"],
  ["shared-environments", "libs/runtime/environments"],
  ["shared-secrets", "libs/runtime/secrets"],
]);

/**
 * One rule per moved library, so the hint names the destination.
 *
 * The trailing `(?![\w-])` is what keeps `packages/shared-control-plane/`
 * (which has NOT moved) from matching the `shared-control-plane-db` rule, and
 * the leading `(?<![\w/.-])` keeps the rule anchored to a repository location
 * rather than firing inside a longer path.
 */
const movedLibraryRules = [...MOVED_LIBRARIES].map(([name, destination]) => ({
  id: `moved-library-${name}`,
  pattern: new RegExp(`(?<![\\w/.-])packages/${name}(?![\\w-])`),
  hint: `\`${name}\` moved to \`${destination}/\` (ADR-0007); the package NAME is unchanged, so imports of \`@polaris/${name}\` still resolve`,
}));

export const RETIRED = [
  ...movedLibraryRules,
  {
    id: "processors-dir",
    pattern: /(?<![\w/.-])processors\/(?:<[a-z_]+>|[a-z][a-z0-9-]*)\//,
    hint: "units live at `{sync,async}/<stage>/<name>/<version>/` — e.g. `async/computation/sessionizer/v2/`",
  },
  {
    id: "consumers-dir",
    pattern: /(?<![\w/.-])consumers\/(?:<[a-z_]+>|[a-z][a-z0-9-]*)\//,
    hint: "destinations live at `sync/destinations/<vendor>/<version>/` — mappers are `src/mapper.ts`",
  },
  {
    // Anchored to the eight kind directories rather than to `catalog/` alone,
    // and that is the whole design of this rule. Three modules are NAMED for
    // the event-catalog concept and keep that name — `apps/ingester-api/src/
    // catalog/`, `apps/polaris-cli/src/catalog/` and `packages/shared-schemas/
    // src/catalog/`. The concept is not the directory, and a pattern matching
    // `catalog/` on its own would fail every import of the three. None of them
    // holds a directory named for one of the eight kinds, so the kind list
    // does the anchoring by itself.
    //
    // The lookbehind refuses a word-ish prefix, so a future
    // `packages/event-catalog/events/` is not a violation. A path separator
    // is allowed through, so prose or a fixture quoting
    // `/workspace/catalog/projects` — the builder path that left two images
    // unbuildable for six days — is one. The Dockerfiles themselves are not
    // scanned here: they carry no extension this check reads, and the
    // exclusion/COPY pairing is `lint-docker-context`'s to police.
    id: "catalog-dir",
    pattern:
      /(?<![\w.-])catalog\/(?:events|traits|audiences|journeys|policy|projects|sources|reverse-etl)(?![\w-])/,
    hint: "declared content lives at `definitions/<kind>/` — e.g. `definitions/traits/`. `catalog` names a connector registry in the industry, and ADR-0007 reserves that role for `connectors/`",
  },
  {
    // `sql/` held exactly one thing -- `sql/clickhouse/` -- and the split it
    // encoded, `db/` for PostgreSQL and `sql/` for ClickHouse, was not a
    // distinction anybody could state. Storage DDL has one home now, with one
    // directory per engine under it.
    //
    // Matched bare, unlike `catalog-dir`, which had to anchor to the eight
    // kind directories to keep the three `src/catalog/` modules legal. There
    // is no `sql` module, package or concept anywhere in this tree to collide
    // with, and prose naming the directory in a list -- the shape both
    // `getting-started.md` and `ci.md` had -- carries no child to anchor to.
    // The lookbehind refuses a word-ish prefix, so `mysql/`, `postgresql/`
    // and `graphql/` are not violations; a path separator passes, so
    // `/workspace/sql/clickhouse` is one.
    id: "sql-dir",
    pattern: /(?<![\w.-])sql\//,
    hint: "storage DDL lives under `db/<engine>/` — ClickHouse DDL is `db/clickhouse/`, PostgreSQL migrations are `db/postgres/migrations/`",
  },
  {
    // The PostgreSQL migrations moved a level down when ClickHouse came in
    // beside them, so `db/` names the storage root rather than one engine.
    // Applied migrations still say `db/migrations` and are meant to: they are
    // skipped here with the rest of `migrations/`, on the rule that a file
    // recording what was true when it ran is not edited to satisfy a lint.
    id: "db-migrations-dir",
    pattern: /(?<![\w.-])db\/migrations(?![\w-])/,
    hint: "PostgreSQL migrations live at `db/postgres/migrations/` — `db/` is the storage root and holds one directory per engine",
  },
  {
    id: "fan-out-model",
    pattern: /[Pp]rocessors fan out from `?raw\.events`?/,
    hint: "the spine chains: raw.events -> sync/identity -> identified.events -> sync/enrichment -> resolved.events. Enrichment lands IN the envelope, not as a sibling event",
  },
  {
    id: "derived-topics-chain",
    pattern:
      /versioned processors\s*(?:\([^)]*\)\s*)?\n?\s*(?:->|-->)\s*(?:RabbitMQ )?derived topics/,
    hint: "the chain is raw.events -> sync/identity -> identified.events -> sync/enrichment -> resolved.events -> sync/destinations",
  },
  {
    id: "enriched-events-family",
    pattern: /(?<![\w.-])enriched\.events(?![\w-])/,
    hint: "`enriched.events` was retired with the fan-out; geoip annotates `resolved.events` in place",
  },
];

/**
 * Files permitted to mention a retired path or model, with the reason.
 *
 * Keep this SHORT. An entry is a claim that the file is about the past on
 * purpose — a catalog tombstone, a migration record, a check that names what
 * it forbids. It is not a place to park a page somebody has not got to yet.
 */
export const HISTORICAL = new Map([
  [
    "definitions/events/enriched/geoip.v1.yaml",
    "the tombstone for the retired event: explaining what it was is its whole job",
  ],
  [
    "libs/spec/src/events/enriched/geoip.v1.ts",
    "the retired event's schema, kept so archived NDJSON stays replayable",
  ],
  [
    "docs/implementation/pipeline-redesign-plan.md",
    "the accepted plan; its before/after tables quote the retired model by design",
  ],
  [
    "docs/implementation/rabbitmq-redesign-plan.md",
    "the earlier accepted plan, describing the topology it moved the platform off",
  ],
  ["scripts/lint-retired-paths.mjs", "this check, which has to name the patterns it refuses"],
  [
    "scripts/__tests__/lint-retired-paths.test.ts",
    "its test, which has to produce a violation to assert one is found",
  ],
  [
    "scripts/__tests__/dashboard-topic-families.test.ts",
    "names the retired families it exists to keep out of the dashboards",
  ],
]);

/**
 * A line that says a thing is GONE is not teaching that it is here.
 *
 * `isCanonicalStreamFamily("enriched.events")` asserted to be `false`, a
 * comment noting a count changed when two families were retired, a
 * migration note — all of these have to name the retired thing to say
 * anything about it, and refusing them would push every such line into the
 * exception list until nobody read it.
 *
 * A heuristic, and a deliberately narrow one: the failing case this check
 * exists for is a line presenting the retired model as CURRENT, and none of
 * those carry a word like `retired` or an assertion of `false`.
 */
const PAST_TENSE =
  /\bretir(?:e|ed|es|ement)\b|\bdeleted\b|\bremoved\b|\breplaced\b|\bno longer\b|\bused to\b|\bwas\b|\bwere\b|\btoBe\(false\)|\.not\.|\buntil\b/i;

/** Lines to test, with the ones that are explicitly about the past removed. */
function scannableLines(source) {
  return source.split("\n").map((line) => (PAST_TENSE.test(line) ? "" : line));
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".") === true) {
      if (entry !== ".github") continue;
    }
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out);
    else if (SCANNED_EXT.has(full.slice(full.lastIndexOf(".")))) out.push(full);
  }
  return out;
}

export function findRetiredPaths(root = DEFAULT_ROOT) {
  const files = [];
  for (const dir of SCAN_DIRS) files.push(...walk(join(root, dir)));
  for (const name of ROOT_FILES) {
    const full = join(root, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      /* absent is fine */
    }
  }

  const problems = [];
  for (const file of files.sort()) {
    const rel = relative(root, file);
    if (HISTORICAL.has(rel)) continue;
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = scannableLines(source);
    for (const rule of RETIRED) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        // Multi-line rules are matched against the joined pair so a diagram
        // split across two lines is still caught.
        const window = rule.pattern.source.includes("\\n")
          ? `${line}\n${lines[i + 1] ?? ""}`
          : line;
        if (!rule.pattern.test(window)) continue;
        problems.push({
          file: rel,
          line: i + 1,
          rule: rule.id,
          text: line.trim().slice(0, 110),
          hint: rule.hint,
        });
      }
    }
  }
  return problems;
}

/** Entries naming a file that no longer exists, or no longer offends. */
export function staleHistorical(root = DEFAULT_ROOT) {
  const stale = [];
  for (const [rel, reason] of HISTORICAL) {
    let source;
    try {
      source = readFileSync(join(root, rel), "utf8");
    } catch {
      stale.push({ file: rel, reason: "listed as historical but does not exist" });
      continue;
    }
    const offends = RETIRED.some((rule) => rule.pattern.test(source));
    if (!offends) {
      stale.push({
        file: rel,
        reason: `listed as historical (${reason}) but no longer mentions anything retired`,
      });
    }
  }
  return stale;
}

function main() {
  const root = process.env["POLARIS_RETIRED_PATH_ROOT"] ?? DEFAULT_ROOT;
  const problems = findRetiredPaths(root);
  const stale = staleHistorical(root);

  if (problems.length === 0 && stale.length === 0) {
    console.log(
      `retired-path check: nothing points at a deleted directory or teaches the retired model ` +
        `(${String(HISTORICAL.size)} file(s) allowed as historical).`,
    );
    return;
  }

  if (problems.length > 0) {
    console.error(
      `retired-path check: ${String(problems.length)} reference(s) to a directory or a pipeline\n` +
        "model that no longer exists. A reader cannot tell a stale sentence from a current one.\n",
    );
    for (const problem of problems) {
      console.error(`  ${problem.file}:${String(problem.line)}  [${problem.rule}]`);
      console.error(`    ${problem.text}`);
      console.error(`    -> ${problem.hint}\n`);
    }
  }
  if (stale.length > 0) {
    console.error("retired-path check: HISTORICAL entries that no longer earn their place.\n");
    for (const entry of stale) console.error(`  ${entry.file}\n    ${entry.reason}\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main();
}
