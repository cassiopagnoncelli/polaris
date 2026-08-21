/**
 * Every alert must read a metric that something actually scrapes.
 *
 * `lint-metric-names.mjs` checks that a metric NAME has a declaring source.
 * It cannot see the next link: whether Prometheus collects from the service
 * that declares it. Nine of twenty alerts failed on exactly that gap --
 * `clickhouse-sink` and all five destinations expose `/metrics` and had no
 * scrape job, so the ClickHouse ingestion-lag, rows-skipped and
 * insert-failure alerts, and every destination alert, could never fire.
 *
 * The insert-failure alert was added in this same programme to replace one
 * that could never fire, and landed unfireable for a different reason. That
 * is the argument for checking the whole chain rather than one link of it:
 * alert -> (recording rule) -> metric family -> emitting service -> scrape job.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Metric-family prefix -> the scrape jobs that could carry it. */
const EMITTED_BY: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["polaris_clickhouse_sink", ["clickhouse-sink"]],
  ["polaris_enrichment", ["sync-enrichment"]],
  ["polaris_clickhouse_operator", ["control-plane-api"]],
  ["polaris_destination", ["braze", "ga4", "meta-capi", "tiktok", "webhook-sink"]],
  ["polaris_operator", ["control-plane-api"]],
  ["polaris_ingest", ["ingester"]],
  ["polaris_identity", ["sync-identity"]],
  [
    "polaris_processor",
    ["sync-identity", "sync-enrichment", "sessionizer", "attribution-engine-v3", "merge-worker"],
  ],
  ["polaris_rabbitmq", ["rabbitmq"]],
];

/**
 * Known-unreachable, with the reason recorded in the rules file itself.
 * The replay executor runs as a CLI invocation with no `/metrics` endpoint,
 * so there is nothing to scrape until a long-running scraper exists.
 */
const KNOWN_UNREACHABLE = new Set(["PolarisReplayJobStuck"]);

function scrapeJobs(): string[] {
  return [...read("infra/prometheus/prometheus.yml").matchAll(/job_name: polaris-(\S+)/g)].map(
    (m) => m[1] as string,
  );
}

/** Recording-rule name -> the raw metric families it is computed from. */
function recordingRuleInputs(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const src = read("infra/prometheus/rules/polaris.recording.yml");
  for (const m of src.matchAll(
    /record:\s*(\S+)\n\s+expr:\s*>?-?\s*([\s\S]*?)(?=\n\s+- record:|\n\s+- name:|$)/g,
  )) {
    out.set(m[1] as string, new Set((m[2] as string).match(/polaris_[a-z0-9_]+/g) ?? []));
  }
  return out;
}

function alerts(): Array<{ name: string; metrics: Set<string> }> {
  const src = read("infra/prometheus/rules/polaris.alerts.yml")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  const rules = recordingRuleInputs();
  return src
    .split(/\n\s+- alert: /)
    .slice(1)
    .map((body) => {
      const metrics = new Set(body.match(/polaris_[a-z0-9_]+/g) ?? []);
      for (const ref of body.match(/polaris:[a-z_]+:[a-z0-9]+/g) ?? []) {
        for (const m of rules.get(ref) ?? []) metrics.add(m);
      }
      return { name: (body.split("\n")[0] ?? "").trim(), metrics };
    });
}

describe("alert reachability", () => {
  it("scrapes a service for every metric family an alert reads", () => {
    const jobs = scrapeJobs();
    const unreachable: string[] = [];

    for (const alert of alerts()) {
      if (alert.metrics.size === 0 || KNOWN_UNREACHABLE.has(alert.name)) continue;
      for (const metric of alert.metrics) {
        const entry = EMITTED_BY.find(([prefix]) => metric.startsWith(prefix));
        if (entry === undefined) continue;
        if (!entry[1].some((svc) => jobs.some((j) => j === svc || j.startsWith(`${svc}-`)))) {
          unreachable.push(`${alert.name} -> ${metric}`);
        }
      }
    }

    expect([...new Set(unreachable)]).toEqual([]);
  });

  it("reads a non-empty set of alerts and jobs, so it cannot pass vacuously", () => {
    expect(alerts().length).toBeGreaterThan(10);
    expect(scrapeJobs().length).toBeGreaterThan(5);
  });

  it("keeps the known-unreachable list honest", () => {
    // An entry here is a claim that the alert is deliberately not wired.
    // If one becomes reachable, it should leave this list rather than sit
    // in it as a permanent excuse.
    const names = new Set(alerts().map((a) => a.name));
    for (const known of KNOWN_UNREACHABLE) expect(names).toContain(known);
  });
});
