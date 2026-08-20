#!/usr/bin/env node
// Polaris metric-name check.
//
// A dashboard panel and an alert rule are code that never runs in CI. They
// parse, they deploy, they render — and if the metric they name is not the
// metric the code emits, the result is a panel that reads EMPTY and an alert
// that never fires. Nothing goes red. The R1D spine dashboard shipped nine
// such panels; they looked like a healthy pipeline with nothing happening,
// which is the most expensive way for observability to be wrong.
//
// So this check asks one narrow question, and answers it exactly:
//
//   does every metric named in a dashboard or a rule file correspond to a
//   metric something in this repository actually emits?
//
// ## What counts as "emitted", and the limit of that
//
// A metric is treated as emitted when its name appears in a TypeScript
// source file — as a string literal, which in this repository always means a
// constant the metrics layer publishes under.
//
// The first draft of this check tried to be stricter: it required the
// constant to be handed to an `increment*` / `observe*` call, so that a name
// declared and never incremented would be reported too. That produced four
// false positives immediately, because emission is not one shape here — the
// ClickHouse sink builds sample objects (`{ name: METRIC_..., labels, value }`)
// in `getSamples()`, and the histogram helpers take their name a level up.
// A check that flags working panels is worse than no check: it gets disabled.
//
// So the guarantee is narrower and honest: this catches a metric name that
// exists NOWHERE in the source — a typo, a rename that missed the dashboard,
// a panel written against a metric someone planned and never built. It does
// NOT catch a name that is declared but never incremented. Nothing in this
// repository is currently in that state, and if one appears, the thing that
// will notice is a reader asking why a panel is empty.
//
// Histogram families are expanded: a metric emitted as
// `polaris_processor_lag_seconds` legitimately appears in a query as
// `polaris_processor_lag_seconds_bucket` / `_sum` / `_count`, because that
// is how Prometheus exposes a histogram.
//
// ## What this check deliberately does NOT do
//
// It does not verify LABELS. Proving that `environment="$environment"`
// selects series the code emits needs call-site analysis: the label types
// declare `environment` optional, so every emitter that shipped without it
// would typecheck and would pass any signature-level check. That class is
// caught by behavioural tests asserting emissions carry their scope — see
// `sync/identity/resolver/v1/test/metrics-labels.test.ts` for the pattern.
// Lint for names, tests for labels.
//
// Run it as:
//
//   node scripts/lint-metric-names.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where metrics are emitted from.
 *
 * Carries ADR-0007's destinations beside the old roots, both epochs at once.
 * A root matching nothing is a no-op; a root missing here would let a metric
 * emitted from `libs/observability/metrics` go unmatched against the
 * dashboards and rules that graph it.
 */
const SOURCE_ROOTS = [
  "apps",
  "sync",
  "async",
  "libs",
  "sdks",
  "connectors",
  "definitions",
];
/** Where metrics are referenced. */
const DASHBOARD_DIR = path.join("infra", "grafana", "dashboards");
const RULE_DIR = path.join("infra", "prometheus", "rules");

/**
 * Series Polaris queries but does not emit: another exporter owns them.
 * Listed explicitly rather than skipped by prefix, so adding a dependency
 * on someone else's metric is a decision someone makes on purpose.
 */
const EXTERNAL_METRICS = new Map([
  ["up", "Prometheus' own per-target sentinel."],
  ["scrape_duration_seconds", "Prometheus scrape metadata."],
  ["scrape_samples_scraped", "Prometheus scrape metadata."],
  ["rabbitmq_", "Served by the broker's rabbitmq_prometheus plugin."],
  ["erlang_", "Served by the broker's Erlang VM exporter."],
  ["ClickHouse", "Served by ClickHouse's own exporter."],
]);

/** PromQL keywords and functions that look like metric names to a regex. */
const PROMQL_WORDS = new Set([
  "sum",
  "rate",
  "irate",
  "increase",
  "avg",
  "min",
  "max",
  "count",
  "count_values",
  "topk",
  "bottomk",
  "quantile",
  "stddev",
  "stdvar",
  "group",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "offset",
  "bool",
  "and",
  "or",
  "unless",
  "histogram_quantile",
  "label_replace",
  "label_join",
  "time",
  "timestamp",
  "vector",
  "scalar",
  "absent",
  "absent_over_time",
  "delta",
  "idelta",
  "deriv",
  "predict_linear",
  "holt_winters",
  "changes",
  "resets",
  "clamp_max",
  "clamp_min",
  "abs",
  "ceil",
  "floor",
  "round",
  "sqrt",
  "exp",
  "ln",
  "log2",
  "log10",
  "sgn",
  "sort",
  "sort_desc",
  "avg_over_time",
  "min_over_time",
  "max_over_time",
  "sum_over_time",
  "count_over_time",
  "quantile_over_time",
  "stddev_over_time",
  "last_over_time",
  "le",
  "job",
  "instance",
  "unless",
  "if",
  "default",
]);

function walk(dir, predicate, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

/**
 * Every `polaris_*` metric name this repository knows about.
 *
 * One pass over the sources for string literals. See the header for why this
 * is deliberately not stricter than that.
 */
function collectEmittedMetrics(rootDir) {
  const files = SOURCE_ROOTS.flatMap((dir) =>
    walk(path.join(rootDir, dir), (f) => f.endsWith(".ts") && !f.endsWith(".d.ts")),
  );

  const live = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/"(polaris_[a-z0-9_]+)"/g)) live.add(match[1]);
  }
  return { live };
}

/** Metric names a PromQL expression references. */
function metricsInExpr(expr) {
  const found = new Set();
  // A metric name is an identifier NOT immediately preceded by `.` or `:`
  // and not followed by `(` — that would make it a function call.
  for (const match of expr.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_:]*)\b(\s*)(\()?/g)) {
    const name = match[1];
    if (match[3] === "(") continue;
    if (PROMQL_WORDS.has(name)) continue;
    if (/^\d/.test(name)) continue;
    found.add(name);
  }
  return found;
}

function collectReferences(rootDir) {
  const refs = [];

  for (const file of walk(path.join(rootDir, DASHBOARD_DIR), (f) => f.endsWith(".json"))) {
    const dashboard = JSON.parse(readFileSync(file, "utf8"));
    for (const panel of dashboard.panels ?? []) {
      for (const target of panel.targets ?? []) {
        if (typeof target.expr !== "string") continue;
        refs.push({ file, where: `panel "${panel.title ?? panel.id}"`, expr: target.expr });
      }
    }
  }

  const recordedNames = new Set();
  const ruleFiles = walk(
    path.join(rootDir, RULE_DIR),
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );
  // Recording rules DEFINE names other rules may reference, so collect the
  // definitions before checking any expression.
  for (const file of ruleFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*-?\s*record:\s*(\S+)\s*$/gm)) {
      recordedNames.add(match[1]);
    }
  }
  for (const file of ruleFiles) {
    const lines = readFileSync(file, "utf8").split("\n");
    let currentAlert = "rule";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const alert = /^\s*-?\s*(?:alert|record):\s*(\S+)/.exec(line);
      if (alert) currentAlert = alert[1] ?? "rule";

      const key = /^(\s*)expr:\s*(.*)$/.exec(line);
      if (key === null) continue;
      const indent = (key[1] ?? "").length;
      const inline = (key[2] ?? "").trim();

      // A block scalar (`|`, `>`) runs until a line indented no further than
      // the `expr:` key itself. Scanning by indent rather than by regex
      // lookahead is what makes this exact: the lookahead version silently
      // dropped every rule that ended its file, and swallowed the comment
      // lines between rules into the expression.
      if (inline === "|" || inline === ">" || /^[|>][-+]?$/.test(inline)) {
        const block = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const next = lines[j] ?? "";
          if (next.trim().length === 0) {
            block.push("");
            continue;
          }
          const nextIndent = next.length - next.trimStart().length;
          if (nextIndent <= indent) break;
          if (/^\s*#/.test(next)) continue;
          block.push(next);
        }
        refs.push({ file, where: currentAlert, expr: block.join("\n") });
      } else if (inline.length > 0 && !inline.startsWith("#")) {
        refs.push({ file, where: currentAlert, expr: inline });
      }
    }
  }
  return { refs, recordedNames };
}

function isExternal(name) {
  for (const key of EXTERNAL_METRICS.keys()) {
    if (name === key || (key.endsWith("_") && name.startsWith(key))) return true;
  }
  return false;
}

/** Histograms expose `_bucket` / `_sum` / `_count` off one emitted base. */
function resolvesToLive(name, live) {
  if (live.has(name)) return true;
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    if (name.endsWith(suffix) && live.has(name.slice(0, -suffix.length))) return true;
  }
  return false;
}

/**
 * Every reference that names a metric no source declares.
 *
 * Exported so the test suite can drive it against a temp tree, the same way
 * `lint-dead-exports` exposes `findDeadExports`.
 */
export function findMetricNameProblems(rootDir) {
  const { live } = collectEmittedMetrics(rootDir);
  const { refs, recordedNames } = collectReferences(rootDir);

  const problems = [];
  for (const ref of refs) {
    for (const name of metricsInExpr(ref.expr)) {
      if (isExternal(name)) continue;
      if (recordedNames.has(name)) continue;
      if (resolvesToLive(name, live)) continue;
      // Only flag things that LOOK like Polaris metrics; a stray label name
      // is not worth a false positive.
      if (!name.startsWith("polaris_")) continue;
      problems.push({ file: path.relative(rootDir, ref.file), where: ref.where, name });
    }
  }
  return { problems, checked: refs.length, live: live.size, recorded: recordedNames.size };
}

function main() {
  const { problems, checked, live, recorded } = findMetricNameProblems(repoRoot);

  if (problems.length > 0) {
    process.stderr.write("metric-name check FAILED\n\n");
    for (const problem of problems) {
      process.stderr.write(
        `  ${problem.file} (${problem.where}): ${problem.name} — no source declares this name\n`,
      );
    }
    process.stderr.write(
      "\nA dashboard or alert names a metric nothing emits. The panel will render\n" +
        "empty and the alert will never fire — neither of which shows up as an error.\n" +
        "Fix the name, emit the metric, or add it to EXTERNAL_METRICS with a reason.\n",
    );
    process.exit(1);
  }

  process.stdout.write(
    `metric-name check: ${checked} expression(s) reference only metrics that are emitted ` +
      `(${live} live, ${recorded} recording rule(s)).\n`,
  );
}

// Only run when invoked directly, so importing for tests does not exit.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
