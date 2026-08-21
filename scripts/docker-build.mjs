#!/usr/bin/env node
/**
 * Polaris Docker image build orchestrator.
 *
 * Builds production images for every service that ships a Dockerfile:
 * apps/{ingester-api, control-plane-api, polaris-cli} and every pipeline
 * unit under {sync,async}/<stage>/<name>/<version>/ — destinations
 * included, since `sync/destinations/` is a stage like any other.
 *
 * Build args (POLARIS_BUILD_VERSION, POLARIS_GIT_SHA, POLARIS_BUILD_TIME)
 * are resolved automatically from `git` and the current ISO timestamp, and
 * surface on /health at runtime via the shared service bootstrap.
 *
 * Usage:
 *   node scripts/docker-build.mjs                 # build all eighteen targets
 *   node scripts/docker-build.mjs ingester-api    # build a single target
 *   node scripts/docker-build.mjs --set representative
 *                                                 # the per-push roster
 *   node scripts/docker-build.mjs --tag v1.2.3    # override image tag
 *   node scripts/docker-build.mjs --list          # list build targets
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
/**
 * Every buildable image.
 *
 * Exported so a test can hold it against POLARIS_COMPONENTS and against
 * the filesystem. `merge-worker` was in the components list with a
 * Dockerfile on disk and no entry here, so the standard build silently
 * produced no image for a deployable service; the retired fan-out left
 * three entries pointing at Dockerfiles that no longer exist, which would
 * have failed the build outright.
 */
export const services = [
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
    // Same omission as merge-worker: a Dockerfile on disk, a component
    // entry, and no build target. Caught by
    // `scripts/__tests__/docker-build.test.ts` the moment `archiver`
    // joined POLARIS_COMPONENTS.
    name: "archiver",
    dockerfile: "async/warehouse/archiver/v1/Dockerfile",
    image: "polaris/processor-archiver-v1",
  },
  {
    name: "journey-orchestrator",
    dockerfile: "async/journeys/orchestrator/v1/Dockerfile",
    image: "polaris/processor-journey-orchestrator-v1",
  },
  {
    name: "clickhouse-sink",
    dockerfile: "async/warehouse/clickhouse-sink/v1/Dockerfile",
    image: "polaris/consumer-clickhouse-sink-v1",
  },
  {
    // In POLARIS_COMPONENTS with a Dockerfile on disk, and absent from this
    // list until 2026-08-18 -- a deployable component the build tooling did
    // not know existed, so `pnpm docker:build` never produced its image.
    name: "merge-worker",
    dockerfile: "async/merges/merge-worker/v1/Dockerfile",
    image: "polaris/processor-merge-worker-v1",
  },
  {
    name: "sessionizer",
    dockerfile: "async/computation/sessionizer/v1/Dockerfile",
    image: "polaris/processor-sessionizer-v1",
  },
  {
    name: "sessionizer-v2",
    dockerfile: "async/computation/sessionizer/v2/Dockerfile",
    image: "polaris/processor-sessionizer-v2",
  },
  {
    name: "attribution-engine-v3",
    dockerfile: "async/computation/attribution-engine/v3/Dockerfile",
    image: "polaris/processor-attribution-engine-v3",
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
 * The canonical template, built like a service but shipping nothing.
 *
 * `infra/docker/base.Dockerfile` is the file every one of the seventeen above
 * is copied from, and its header says Docker is not asked to build it. That
 * sentence is why it drifted: `719a9d2` took the stale pnpm pin out of the
 * seventeen and missed the template, so the file designated as the shape of
 * every image sat a major version behind the images it governs, and nothing
 * could say so because nothing built it.
 *
 * Building it needs a real `SERVICE_FILTER` — the default is
 * `@polaris/EXAMPLE`, which matches no package, so an unparameterised build
 * fails at `pnpm deploy` for a reason that says nothing about the template.
 * A destination is the cheapest real closure in the tree, and it makes the
 * per-push set cover a third stage rather than repeat one of the other two.
 *
 * The image ships nowhere. `base-template` is named so that anything found
 * running it is a mistake, not a deployment.
 */
export const templates = [
  {
    name: "base",
    dockerfile: "infra/docker/base.Dockerfile",
    image: "polaris/base-template",
    buildArgs: {
      SERVICE_FILTER: "@polaris/consumer-webhook-sink-v1",
      SERVICE_ENTRY: "main.js",
    },
  },
];

/**
 * Every buildable target: the seventeen images that ship, plus the template.
 *
 * Eighteen is the number `scripts/lint-docker-deploy.mjs` already counts, and
 * it counts the template among them for the same reason this list does.
 */
export const targets = [...services, ...templates];

/**
 * The per-push roster: one sync unit, one async unit, the template.
 *
 * Recorded here rather than in the workflow so that CI and a developer run
 * the same set by the same name, and so the reasoning for each member sits
 * with the membership.
 *
 * Both defects this gate exists for lived in the shared build context or the
 * base image, so the set is chosen to cover the ways a unit can depend on
 * that context rather than to sample the tree evenly:
 *
 *   - `sync-identity` COPIES `definitions/projects` out of the builder into
 *     its runtime stage. That is the half of the `.dockerignore` fault that
 *     broke it and `sync-enrichment` for six days.
 *   - `journey-orchestrator` is the async unit that depends on the
 *     `definitions/*` workspace packages with `workspace:*`, which is the
 *     other half of the same fault — the builder cannot compile without the
 *     directory, whatever the runtime stage copies.
 *   - `base` is the template the other seventeen are copied from.
 *
 * The three apps build nightly only. That is the granularity the decision on
 * `5OV81` chose; widening it is a one-line edit here.
 */
export const REPRESENTATIVE = ["sync-identity", "journey-orchestrator", "base"];

/** Named rosters selectable with `--set`. */
export const SETS = {
  representative: REPRESENTATIVE,
  full: targets.map((t) => t.name),
};

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
      "  --set <name>    build a named roster: " + Object.keys(SETS).join(", "),
      "  --no-cache      pass --no-cache to docker build",
      "  --pull          pass --pull to docker build (refresh base images)",
      "  --list          list build targets and exit",
      "  --dry-run       print the docker build commands without running them",
      "  --help          print this message",
      "",
      "Targets (* = in the representative set, built on every push):",
      ...targets.map(
        (t) =>
          `  ${REPRESENTATIVE.includes(t.name) ? "*" : " "} ${t.name.padEnd(22)}  ${t.dockerfile}`,
      ),
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    tag: undefined,
    set: /** @type {string | undefined} */ (undefined),
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
      case "--set":
        i += 1;
        args.set = argv[i];
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

/**
 * Resolve the roster to build.
 *
 * Named targets and `--set` resolve against the same list, so `--set
 * representative` and naming its three members are the same build. An unknown
 * set name exits rather than falling back to everything: a typo that quietly
 * built all eighteen would be an expensive surprise, and one that quietly
 * built none would be a green tick for no work.
 */
function selectTargets(names, setName) {
  if (setName !== undefined) {
    const set = SETS[setName];
    if (set === undefined) {
      process.stderr.write(
        `unknown set '${setName}'. Available: ${Object.keys(SETS).join(", ")}.\n`,
      );
      process.exit(2);
    }
    names = [...set, ...names];
  }
  if (names.length === 0) return targets;
  const selected = [];
  for (const name of names) {
    const match = targets.find((t) => t.name === name);
    if (!match) {
      process.stderr.write(`unknown target '${name}'. Run --list to see available targets.\n`);
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
  // A target's own args, after the three metadata ones so a target can
  // override a default rather than merely add to it. Only the template uses
  // this: a unit's filter and entrypoint are written into its Dockerfile,
  // which is what makes it a unit rather than a parameterised template.
  for (const [key, value] of Object.entries(service.buildArgs ?? {})) {
    args.push("--build-arg", `${key}=${value}`);
  }
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
    for (const t of targets) {
      const mark = REPRESENTATIVE.includes(t.name) ? "*" : " ";
      process.stdout.write(`${mark} ${t.name.padEnd(22)}  ${t.image}  ${t.dockerfile}\n`);
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

  const selected = selectTargets(args.targets, args.set);
  process.stdout.write(
    `Building ${selected.length} image(s)${args.set ? ` (set: ${args.set})` : ""}\n  tag=${tag}\n  version=${version}\n  git_sha=${gitSha}\n  build_time=${buildTime}\n`,
  );

  let failures = 0;
  for (const service of selected) {
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
  // A dry run must not claim the images built. This script is the gate
  // `images.yml` runs, and "All 18 image(s) built successfully" printed by a
  // run that invoked docker zero times is precisely the green-for-no-work
  // this repository keeps having to dig out of its own checks.
  if (opts.dryRun) {
    process.stdout.write(`\nDry run: ${selected.length} image(s) NOT built.\n`);
    return 0;
  }
  process.stdout.write(`\nAll ${selected.length} image(s) built successfully\n`);
  return 0;
}

// Only when RUN as a script, never on import. Without this guard, importing
// the module to read `services` starts building images -- which is exactly
// what happened the first time a test imported it. Same shape as the guard
// in `lint-trait-sql.mjs`.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`unexpected failure: ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
