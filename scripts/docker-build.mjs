#!/usr/bin/env node
/**
 * Polaris Docker image build orchestrator.
 *
 * Builds production images for every service that ships a Dockerfile:
 * apps/{ingester-api, control-plane-api, polaris-cli}, every processor
 * under processors/<name>/v*\/, and every consumer under consumers/<name>/v*\/.
 *
 * Build args (POLARIS_BUILD_VERSION, POLARIS_GIT_SHA, POLARIS_BUILD_TIME)
 * are resolved automatically from `git` and the current ISO timestamp, and
 * surface on /health at runtime via the shared service bootstrap.
 *
 * Usage:
 *   node scripts/docker-build.mjs                 # build every service
 *   node scripts/docker-build.mjs ingester-api    # build a single service
 *   node scripts/docker-build.mjs --tag v1.2.3    # override image tag
 *   node scripts/docker-build.mjs --list          # list service targets
 *   node scripts/docker-build.mjs --help
 *
 * The `pnpm docker:build` script in the root package.json wires this in.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/**
 * Inventory of buildable services. Keep this aligned with the actual
 * Dockerfiles on disk; the build script verifies each entry exists before
 * shelling out to docker, so adding/removing services is a one-line edit.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   dockerfile: string,
 *   image: string,
 * }>}
 */
const services = [
  {
    name: "ingester-api",
    dockerfile: "apps/ingester-api/Dockerfile",
    image: "polaris/ingester-api",
  },
  {
    name: "control-plane-api",
    dockerfile: "apps/control-plane-api/Dockerfile",
    image: "polaris/control-plane-api",
  },
  {
    name: "polaris-cli",
    dockerfile: "apps/polaris-cli/Dockerfile",
    image: "polaris/polaris-cli",
  },
  {
    name: "analytics-projector",
    dockerfile: "sync/legacy/analytics-projector/v1/Dockerfile",
    image: "polaris/processor-analytics-projector-v1",
  },
  {
    name: "sync-identity",
    dockerfile: "sync/identity/resolver/v1/Dockerfile",
    image: "polaris/sync-identity-resolver-v1",
  },
  {
    name: "sync-enrichment",
    dockerfile: "sync/enrichment/runtime/v1/Dockerfile",
    image: "polaris/sync-enrichment-runtime-v1",
  },
  {
    name: "clickhouse-sink",
    dockerfile: "async/warehouse/clickhouse-sink/v1/Dockerfile",
    image: "polaris/consumer-clickhouse-sink-v1",
  },
  {
    name: "identity-resolver",
    dockerfile: "sync/legacy/identity-resolver/v1/Dockerfile",
    image: "polaris/processor-identity-resolver-v1",
  },
  {
    name: "sessionizer",
    dockerfile: "async/computation/sessionizer/v1/Dockerfile",
    image: "polaris/processor-sessionizer-v1",
  },
  {
    name: "geoip-enricher",
    dockerfile: "sync/legacy/geoip-enricher/v1/Dockerfile",
    image: "polaris/processor-geoip-enricher-v1",
  },
  {
    name: "attribution-engine",
    dockerfile: "async/computation/attribution-engine/v1/Dockerfile",
    image: "polaris/processor-attribution-engine-v1",
  },
  {
    name: "webhook-sink",
    dockerfile: "sync/destinations/webhook-sink/v1/Dockerfile",
    image: "polaris/consumer-webhook-sink-v1",
  },
  {
    name: "meta-capi",
    dockerfile: "sync/destinations/meta-capi/v1/Dockerfile",
    image: "polaris/consumer-meta-capi-v1",
  },
  {
    name: "tiktok",
    dockerfile: "sync/destinations/tiktok/v1/Dockerfile",
    image: "polaris/consumer-tiktok-v1",
  },
  {
    name: "ga4",
    dockerfile: "sync/destinations/ga4/v1/Dockerfile",
    image: "polaris/consumer-ga4-v1",
  },
  {
    name: "braze",
    dockerfile: "sync/destinations/braze/v1/Dockerfile",
    image: "polaris/consumer-braze-v1",
  },
];

/**
 * Run a synchronous shell command and capture its trimmed stdout, returning
 * the fallback string when the command fails. Used to gather optional build
 * metadata (git sha, version) without making the script brittle.
 */
function runOr(cmd, args, fallback) {
  const result = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0 || result.stdout === undefined) return fallback;
  return result.stdout.trim() || fallback;
}

function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function printHelp() {
  process.stdout.write(
    [
      "Polaris Docker image build orchestrator",
      "",
      "Usage:",
      "  node scripts/docker-build.mjs [service...] [options]",
      "",
      "Options:",
      "  --tag <tag>     image tag suffix (default: 'dev' or POLARIS_BUILD_VERSION)",
      "  --no-cache      pass --no-cache to docker build",
      "  --pull          pass --pull to docker build (refresh base images)",
      "  --list          list service targets and exit",
      "  --dry-run       print the docker build commands without running them",
      "  --help          print this message",
      "",
      "Services:",
      ...services.map((s) => `  ${s.name.padEnd(22)}  ${s.dockerfile}`),
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    tag: undefined,
    noCache: false,
    pull: false,
    list: false,
    dryRun: false,
    help: false,
    targets: /** @type {string[]} */ ([]),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--no-cache":
        args.noCache = true;
        break;
      case "--pull":
        args.pull = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--tag":
        i += 1;
        args.tag = argv[i];
        break;
      default:
        if (arg?.startsWith("--")) {
          process.stderr.write(`unknown flag: ${arg}\n`);
          process.exit(2);
        }
        if (arg !== undefined) args.targets.push(arg);
    }
  }
  return args;
}

function selectServices(targets) {
  if (targets.length === 0) return services;
  const selected = [];
  for (const name of targets) {
    const match = services.find((s) => s.name === name);
    if (!match) {
      process.stderr.write(`unknown service '${name}'. Run --list to see available targets.\n`);
      process.exit(2);
    }
    selected.push(match);
  }
  return selected;
}

function buildOne(service, buildArgs, opts) {
  const dockerfilePath = path.resolve(repoRoot, service.dockerfile);
  if (!existsSync(dockerfilePath)) {
    process.stderr.write(`missing Dockerfile: ${service.dockerfile}\n`);
    return 2;
  }
  const args = [
    "build",
    "-f",
    service.dockerfile,
    "-t",
    `${service.image}:${opts.tag}`,
    "--build-arg",
    `POLARIS_BUILD_VERSION=${buildArgs.version}`,
    "--build-arg",
    `POLARIS_GIT_SHA=${buildArgs.gitSha}`,
    "--build-arg",
    `POLARIS_BUILD_TIME=${buildArgs.buildTime}`,
  ];
  if (opts.noCache) args.push("--no-cache");
  if (opts.pull) args.push("--pull");
  args.push(".");

  process.stdout.write(`\n[${service.name}] docker ${args.join(" ")}\n`);
  if (opts.dryRun) return 0;
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.list) {
    for (const s of services) {
      process.stdout.write(`${s.name.padEnd(22)}  ${s.image}  ${s.dockerfile}\n`);
    }
    return 0;
  }

  const version =
    process.env.POLARIS_BUILD_VERSION ||
    runOr("git", ["describe", "--tags", "--always", "--dirty"], "0.0.0-dev");
  const gitSha = process.env.POLARIS_GIT_SHA || runOr("git", ["rev-parse", "HEAD"], "unknown");
  const buildTime = process.env.POLARIS_BUILD_TIME || isoNow();
  const tag = args.tag || process.env.POLARIS_IMAGE_TAG || version;

  const buildArgs = { version, gitSha, buildTime };
  const opts = { tag, noCache: args.noCache, pull: args.pull, dryRun: args.dryRun };

  const targets = selectServices(args.targets);
  process.stdout.write(
    `Building ${targets.length} image(s)\n  tag=${tag}\n  version=${version}\n  git_sha=${gitSha}\n  build_time=${buildTime}\n`,
  );

  let failures = 0;
  for (const service of targets) {
    const status = buildOne(service, buildArgs, opts);
    if (status !== 0) {
      failures += 1;
      process.stderr.write(`\nbuild failed: ${service.name} (status ${status})\n`);
    }
  }

  if (failures > 0) {
    process.stderr.write(`\n${failures} build(s) failed\n`);
    return 1;
  }
  process.stdout.write(`\nAll ${targets.length} image(s) built successfully\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`unexpected failure: ${error?.message ?? error}\n`);
    process.exit(1);
  });
