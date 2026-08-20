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
import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Every workspace package whose `dev` script binds a port, found by walking.
 *
 * This was a hardcoded list of fifteen directories, which made the test
 * blind to exactly the thing it exists to catch: a new service added with a
 * `dev` port and never entered in the registry. Discovering them means the
 * registry-coverage assertion below actually bites.
 */
function devScriptPorts(): Map<string, { port: number; serviceName: string; dir: string }> {
  const found = new Map<string, { port: number; serviceName: string; dir: string }>();
  const walk = (dir: string): void => {
    // ENOENT only. A blanket catch here swallowed a ReferenceError from a
    // missing import and made the walk silently return nothing, which read
    // as "no packages declare a port" -- the fail-open shape this whole
    // file exists to prevent.
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true, encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", "test", "__tests__", "src"].includes(entry.name)) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name === "package.json") {
        const pkg = JSON.parse(read(rel)) as { name?: string; scripts?: Record<string, string> };
        const dev = pkg.scripts?.["dev"] ?? "";
        const port = /POLARIS_HTTP_PORT=(\d+)/.exec(dev)?.[1];
        if (pkg.name !== undefined && port !== undefined) {
          found.set(pkg.name, {
            port: Number(port),
            serviceName: /POLARIS_SERVICE_NAME=(\S+)/.exec(dev)?.[1] ?? "",
            dir,
          });
        }
      }
    }
  };
  for (const root of ["apps", "sync", "async", "packages", "libs"]) walk(root);
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
    // Keyed off the `polaris_service` label each job already carries, not a
    // job-name-to-service map maintained here. The map was a second copy of
    // the registry sitting inside its own test.
    const prom = read("infra/prometheus/prometheus.yml");
    const mismatches: string[] = [];

    for (const m of prom.matchAll(
      /- targets: \["host\.docker\.internal:(\d+)"\]\n\s+labels:\n\s+polaris_service: (\S+)/g,
    )) {
      const port = Number(m[1]);
      const service = m[2] as string;
      // A service name can cover two versioned jobs (sessionizer v1/v2), so
      // a target matches if it equals ANY registry port for that name.
      const candidates = Object.entries(REGISTRY.services)
        .filter(([key]) => key === service || key.startsWith(`${service}-v`))
        .map(([, value]) => value);
      if (candidates.length === 0) {
        mismatches.push(`scrape target ${service}:${String(port)} is not in the registry`);
      } else if (!candidates.includes(port)) {
        mismatches.push(
          `${service}: scrapes ${String(port)}, registry says ${candidates.join("/")}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
    // Bites only if it read some targets.
    expect([...prom.matchAll(/polaris_service: /g)].length).toBeGreaterThan(10);
  });

  it("has a registry entry for every package that binds a port", () => {
    // The assertion the hardcoded directory list made impossible. A new
    // service with a `dev` port and no registry entry is how the ports
    // drifted in the first place.
    const known = new Set(Object.values(REGISTRY.packageForService));
    const unregistered = [...devScriptPorts().keys()].filter((pkg) => !known.has(pkg));

    expect(unregistered).toEqual([]);
  });

  it("reads a non-empty registry, so none of the above passes vacuously", () => {
    expect(Object.keys(REGISTRY.services).length).toBeGreaterThan(10);
    expect(devScriptPorts().size).toBeGreaterThan(10);
  });
});
