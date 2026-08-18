/**
 * One port per service, in one place, checked against every consumer.
 *
 * The ports lived only in each package's `dev` script and were copied by
 * hand into `prometheus.yml`, the CI workflow and the observability doc.
 * They had already drifted in both directions: Prometheus scraped the
 * ingester on 8080 while its dev script binds 4000, six services had no
 * scrape job at all because nobody knew which port to write down, and
 * `@polaris/processor-traits-v1` carried a `dev` script naming itself
 * `sessionizer`, binding sessionizer-v2's port, and running a `src/main.ts`
 * that does not exist.
 *
 * `bin/dev` reads ports out of the `dev` scripts at runtime, so those stay
 * the executable source. This holds them against `infra/service-ports.json`
 * so the registry cannot become a fourth opinion.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

interface Registry {
  readonly services: Record<string, number>;
  readonly packageForService: Record<string, string>;
}
const REGISTRY = JSON.parse(read("infra/service-ports.json")) as Registry;

/** Every workspace package that declares a port in its `dev` script. */
function devScriptPorts(): Map<string, { port: number; serviceName: string }> {
  const out = new Map<string, { port: number; serviceName: string }>();
  for (const [, pkgName] of Object.entries(REGISTRY.packageForService)) {
    out.set(pkgName, { port: Number.NaN, serviceName: "" });
  }
  // Resolve each package's directory from the pnpm workspace by reading the
  // package.json the registry names. Walk rather than glob: the tree layout
  // is `{sync,async}/<stage>/<name>/<version>` and apps/ is flat.
  const dirs = [
    "apps/ingester-api",
    "apps/control-plane-api",
    "sync/identity/resolver/v1",
    "sync/enrichment/runtime/v1",
    "sync/destinations/webhook-sink/v1",
    "sync/destinations/meta-capi/v1",
    "sync/destinations/ga4/v1",
    "sync/destinations/tiktok/v1",
    "sync/destinations/braze/v1",
    "async/computation/sessionizer/v1",
    "async/computation/sessionizer/v2",
    "async/computation/attribution-engine/v3",
    "async/merges/merge-worker/v1",
    "async/warehouse/archiver/v1",
    "async/warehouse/clickhouse-sink/v1",
  ];
  const found = new Map<string, { port: number; serviceName: string }>();
  for (const dir of dirs) {
    const pkg = JSON.parse(read(`${dir}/package.json`)) as {
      name: string;
      scripts?: Record<string, string>;
    };
    const dev = pkg.scripts?.["dev"] ?? "";
    const port = /POLARIS_HTTP_PORT=(\d+)/.exec(dev)?.[1];
    const svc = /POLARIS_SERVICE_NAME=(\S+)/.exec(dev)?.[1];
    if (port !== undefined) {
      found.set(pkg.name, { port: Number(port), serviceName: svc ?? "" });
    }
  }
  return found;
}

describe("service port registry", () => {
  it("matches every package's dev script", () => {
    const dev = devScriptPorts();
    const mismatches: string[] = [];

    for (const [service, port] of Object.entries(REGISTRY.services)) {
      const pkg = REGISTRY.packageForService[service];
      if (pkg === undefined) {
        mismatches.push(`${service}: no package mapping`);
        continue;
      }
      const actual = dev.get(pkg);
      if (actual === undefined) mismatches.push(`${service}: ${pkg} declares no dev port`);
      else if (actual.port !== port) {
        mismatches.push(`${service}: registry ${port}, dev script ${actual.port}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("gives every service a distinct port", () => {
    const seen = new Map<number, string>();
    const clashes: string[] = [];
    for (const [service, port] of Object.entries(REGISTRY.services)) {
      const prior = seen.get(port);
      if (prior !== undefined) clashes.push(`${prior} and ${service} both on ${port}`);
      seen.set(port, service);
    }
    expect(clashes).toEqual([]);
  });

  it("names itself correctly in every dev script", () => {
    // `traits` bound sessionizer-v2's port AND called itself `sessionizer`,
    // so a metrics scrape would have labelled its samples as another
    // service's. The name is as load-bearing as the number.
    const dev = devScriptPorts();
    const wrong: string[] = [];
    for (const [service, pkg] of Object.entries(REGISTRY.packageForService)) {
      const actual = dev.get(pkg);
      if (actual === undefined) continue;
      // sessionizer v1 and v2 share a service name deliberately: same
      // processor, two versions, told apart by port and manifest version.
      const expected = service.replace(/-v\d+$/, "");
      if (actual.serviceName !== expected) {
        wrong.push(`${pkg}: declares ${actual.serviceName}, expected ${expected}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("matches every Prometheus scrape target", () => {
    const prom = read("infra/prometheus/prometheus.yml");
    const JOB_TO_SERVICE: Record<string, string> = {
      ingester: "ingester-api",
      "control-plane-api": "control-plane-api",
      "sync-identity": "sync-identity",
      "sync-enrichment": "sync-enrichment",
      sessionizer: "sessionizer",
      "sessionizer-v2": "sessionizer-v2",
      "attribution-engine-v3": "attribution-engine",
      "merge-worker": "merge-worker",
      archiver: "archiver",
      "clickhouse-sink": "clickhouse-sink",
      "webhook-sink": "webhook-sink",
      "meta-capi": "meta-capi",
      ga4: "ga4",
      tiktok: "tiktok",
      braze: "braze",
    };
    const mismatches: string[] = [];
    for (const m of prom.matchAll(
      /job_name: polaris-(\S+)\n(?:.*\n){1,4}?\s+- targets: \["host\.docker\.internal:(\d+)"\]/g,
    )) {
      const service = JOB_TO_SERVICE[m[1] as string];
      if (service === undefined) continue;
      const expected = REGISTRY.services[service];
      if (expected !== Number(m[2])) {
        mismatches.push(`polaris-${m[1]}: scrapes ${m[2]}, registry says ${String(expected)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("reads a non-empty registry, so none of the above passes vacuously", () => {
    expect(Object.keys(REGISTRY.services).length).toBeGreaterThan(10);
    expect(devScriptPorts().size).toBeGreaterThan(10);
  });
});
