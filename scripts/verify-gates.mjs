/**
 * Prove every gate can fail.
 *
 * A check nobody has watched fail is a check nobody knows works. This
 * session produced three that passed on the exact bug they were written
 * for: one asked `EXPLAIN SYNTAX`, which parses without resolving
 * identifiers; one probed MinIO's health path, which answers 400; one
 * counted a comment saying a variable is NOT read as a use of it. Each
 * reported everything healthy while the defect sat in front of it.
 *
 * So: for each gate, break something it is supposed to notice, run it,
 * and require a non-zero exit. Restore, and move on.
 *
 * ## Verifying the INJECTION is half the work
 *
 * Three injections here initially "passed" for reasons that had nothing
 * to do with the gate — a dashboard panel with no `targets` key, and a
 * config canary written to source and `dist` when the gate reads a
 * GENERATED json. Both looked exactly like a decorative gate. So every
 * entry declares `assertInjected`: a predicate that must hold after the
 * mutation, before the gate's verdict means anything.
 *
 * ## The harness must not be a reference to its own canaries
 *
 * `lint-dead-exports` and `lint-env-example` both search `scripts/` for
 * uses. Spelling a canary as a literal here made this file a legitimate
 * use of it, and both gates correctly reported the symbol referenced —
 * which the harness then read as "the gate is blind". The canaries are
 * assembled from fragments so no gate can see them, which is why the
 * names below look the way they do.
 *
 * Refuses to run on a dirty tree, because restoring is `git checkout`.
 *
 * Three rosters. The default needs nothing but the checkout, and static
 * analysis runs it on every push. The other two need something a runner has
 * to be given, and each is opted into by the workflow that has it:
 *
 *   node scripts/verify-gates.mjs                    # the default roster
 *   node scripts/verify-gates.mjs --with-services    # + a live ClickHouse
 *   node scripts/verify-gates.mjs --with-docker      # + a Docker daemon
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = "libs/bus/src/streams.ts";

/**
 * Canary names, assembled rather than written.
 *
 * `lint-dead-exports` and `lint-env-example` search `scripts/` for uses
 * of a symbol. A literal here IS a use, so both gates saw the canary as
 * referenced and this harness read that as the gate being blind.
 */
const DEAD_EXPORT_CANARY = `never${"Called"}CanaryXyz`;
const ENV_READ_CANARY = `POLARIS_${"CANARY"}_XYZ`;
const ENV_DOC_CANARY = `POLARIS_${"DRIFT"}_CANARY`;

/**
 * The retired path, assembled for the reason above — and this one caught
 * itself. Written as a literal, `lint-retired-paths` correctly reported two
 * violations in THIS file, so the gate went permanently red the moment its
 * own entry was added. Same failure as the dead-export and env-doc canaries,
 * one check later.
 */
const RETIRED_PATH_CANARY = `consumers${"/"}<vendor>/v<n>/mappers/`;

/**
 * A project-config key nothing reads.
 *
 * `lint-project-config-keys` scans the declaring component's `src/` for the
 * key, EXCLUDING the file that declares it — a key mentioned only in its own
 * declaration is operator surface that changes nothing when set. So the
 * injection has to add a property to the generated schema artifact, which is
 * what that lint reads, and leave the component's source alone.
 */
const CONFIG_KEY_CANARY = `unread_${"canary"}_key`;

/**
 * The exclusion that broke the identity and enrichment images.
 *
 * Written as a literal, unlike the canaries above: `lint-docker-context`
 * reads `.dockerignore` and Dockerfiles and nothing else, so a mention in
 * this file cannot be mistaken for a use.
 *
 * The directory was called `catalog` when it broke them. It is the CURRENT
 * name that has to go in here: the canary proves the gate by re-creating the
 * fault, and excluding a directory no Dockerfile copies any more would prove
 * the gate blind when it is merely being asked the wrong question.
 */
const DOCKER_CONTEXT_CANARY = "definitions";

/**
 * A context path no build provides.
 *
 * Written as a literal, like `DOCKER_CONTEXT_CANARY` and for the same reason:
 * `lint-docker-context` reads `.dockerignore` and Dockerfiles and nothing
 * else, so a mention here cannot be mistaken for a use.
 *
 * It is deliberately a path that NO lint can object to. `.dockerignore` does
 * not prune it -- there is nothing to prune, the path does not exist -- so
 * `lint-docker-context` passes on the injected file and only the build itself
 * can notice. That is the whole case for building images in CI: the static
 * checks around Docker answer questions about the text, and a Dockerfile can
 * satisfy every one of them and still not build.
 */
const DOCKER_BUILD_CANARY = "context-canary-xyz-does-not-exist";

/** A column no ClickHouse table has. Assembled, like every canary here. */
const SQL_COLUMN_CANARY = `no_such_${"column"}_xyz`;

/**
 * The prefix ADR-0007 retired, assembled like the rest.
 *
 * `lint-package-name-congruence` reads `name` out of package.json and nothing
 * else, so a literal here could not be mistaken for a use — but `git grep
 * "@polaris/shared-"` is IJ4NN's acceptance criterion, and a literal would put
 * a permanent hit in `scripts/`. Assembling it keeps the criterion answerable
 * by the command the card names, which is the whole point of writing it as a
 * grep.
 */
const PACKAGE_NAME_CANARY = `@polaris/${"shared"}-governance`;

/**
 * A blueprint link target ADR-0007 deleted, assembled like the rest.
 *
 * `lint-retired-paths` does not match this spelling as it stands — its
 * `packages-dir` rule wants a trailing slash or a word boundary, and a
 * package name supplies neither. It is one edit away from supplying both,
 * which is the trap every other canary in this file was assembled to avoid.
 */
const BLUEPRINT_LINK_CANARY = `link:../../${"packages"}/node-sdk`;

/**
 * The pnpm the blueprint's install actually ran under while the root pinned
 * 11.21.0 — the fault re-created rather than one invented for the harness.
 *
 * Written as a literal, unlike the assembled canaries above. The only check
 * that reads a `pnpm@x.y.z` is `lint-docker-deploy`, which reads Dockerfiles
 * and nothing else, so a mention in this file cannot be mistaken for a pin.
 */
const BLUEPRINT_PNPM_CANARY = "pnpm@10.30.0";

/**
 * The one line that keeps every image buildable.
 *
 * The inverse of every canary above: this fault is an ABSENCE, so the
 * injection removes the repository's own declaration rather than planting a
 * foreign one. It is commented out rather than deleted, which YAML reads as
 * identical -- `parse` never sees a commented key, `pnpm config get` resolves
 * to `undefined`, and `pnpm deploy` refuses with
 * ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE, the error that made seventeen images
 * unbuildable from the day the runtime moved to pnpm v10. Commenting keeps the
 * assertion POSITIVE, and a positive assertion is the one that cannot pass by
 * accident: were the key ever renamed, the replace would no-op, the commented
 * line would be absent, and the harness would report an injection that did not
 * land. Deleting by pattern fails that way silently -- a filter that matches
 * nothing leaves a clean tree that satisfies "the key is gone".
 *
 * Written as a literal. `lint-docker-deploy` reads pnpm-workspace.yaml and
 * Dockerfiles and nothing else, so a mention in this file cannot be mistaken
 * for a declaration.
 */
const DEPLOY_INJECTION_LINE = "injectWorkspacePackages: true";

/**
 * The gate whose absence from the group verify set let a red `main` land.
 *
 * Written as a literal. `lint-gate-parity` reads the `scripts` block of
 * package.json and the workflows, and this file is neither, so a mention here
 * cannot be mistaken for a declaration.
 */
const GATE_PARITY_INJECTION = " && pnpm format:check";

const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "pipe" }).toString();
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const write = (file, body) => writeFileSync(join(ROOT, file), body);
const append = (file, text) => write(file, read(file) + text);

/**
 * One gate, one fault it must notice.
 *
 * `files` are restored with `git checkout` afterwards. `assertInjected`
 * runs after `inject` and before the gate — it is what distinguishes "the
 * gate is blind" from "my fault never landed".
 */
const GATES = [
  {
    name: "biome lint",
    command: `npx biome lint ${SCRATCH}`,
    files: [SCRATCH],
    inject: () => append(SCRATCH, "\nconst unusedCanaryXyz = 1\n"),
    assertInjected: () => read(SCRATCH).includes("unusedCanaryXyz"),
  },
  {
    name: "lint:clickhouse-imports",
    command: "node scripts/lint-clickhouse-imports.mjs",
    files: [SCRATCH],
    inject: () => append(SCRATCH, '\nimport { createClient } from "@clickhouse/client";\n'),
    assertInjected: () => read(SCRATCH).includes("@clickhouse/client"),
  },
  {
    name: "lint:nul-bytes",
    command: "node scripts/lint-nul-bytes.mjs",
    files: [SCRATCH],
    inject: () => append(SCRATCH, `\n// canary ${String.fromCharCode(0)}\n`),
    assertInjected: () => read(SCRATCH).includes(String.fromCharCode(0)),
  },
  {
    name: "lint:dead-exports",
    command: "node scripts/lint-dead-exports.mjs",
    files: [SCRATCH],
    inject: () => append(SCRATCH, `\nexport function ${DEAD_EXPORT_CANARY}(): void {}\n`),
    assertInjected: () => read(SCRATCH).includes(DEAD_EXPORT_CANARY),
  },
  {
    name: "lint:process-env",
    command: "node scripts/lint-process-env.mjs",
    files: [SCRATCH],
    inject: () => append(SCRATCH, `\nconst c = process.env["${ENV_READ_CANARY}"];\nvoid c;\n`),
    assertInjected: () => read(SCRATCH).includes(ENV_READ_CANARY),
  },
  {
    name: "lint:trait-sql",
    command: "node scripts/lint-trait-sql.mjs",
    files: ["definitions/traits/orders-30d.ts"],
    inject: () =>
      write(
        "definitions/traits/orders-30d.ts",
        read("definitions/traits/orders-30d.ts").replace(
          "FROM polaris.profile_event_daily_counts",
          "FROM polaris.analytics_raw",
        ),
      ),
    assertInjected: () =>
      read("definitions/traits/orders-30d.ts").includes("FROM polaris.analytics_raw"),
  },
  {
    // A declared key that nothing reads. Injected into the GENERATED artifact
    // rather than into a component's `project-config.ts`, because that is the
    // file the lint reads — and a canary in the source would also have to be
    // absent from the rest of `src/`, which is a harder thing to arrange than
    // it is to verify.
    name: "lint:project-config-keys",
    command: "node scripts/lint-project-config-keys.mjs",
    files: ["libs/tenancy/config-schemas/schemas/ingest.project.schema.json"],
    inject: () => {
      const path = "libs/tenancy/config-schemas/schemas/ingest.project.schema.json";
      const schema = JSON.parse(read(path));
      schema.properties[CONFIG_KEY_CANARY] = { type: "string" };
      write(path, `${JSON.stringify(schema, null, 2)}\n`);
    },
    assertInjected: () =>
      read("libs/tenancy/config-schemas/schemas/ingest.project.schema.json").includes(
        CONFIG_KEY_CANARY,
      ),
  },
  {
    // Drift between a component's Zod schema and its checked-in artifact.
    // Injected into the SOURCE, not the artifact: the generator regenerates
    // from source and diffs against disk, so mutating the artifact alone is
    // the same fault from the other side and would also be caught — but
    // mutating the source is the direction a real change arrives from.
    name: "config-schemas:check",
    command: "node scripts/project-config-schemas-generate.mjs --check",
    files: ["apps/ingester-api/src/project-config.ts"],
    inject: () =>
      write(
        "apps/ingester-api/src/project-config.ts",
        read("apps/ingester-api/src/project-config.ts").replace(
          "rate_limit_rps: positiveIntSchema.optional(),",
          `rate_limit_rps: positiveIntSchema.optional(),\n  ${CONFIG_KEY_CANARY}: positiveIntSchema.optional(),`,
        ),
      ),
    assertInjected: () =>
      read("apps/ingester-api/src/project-config.ts").includes(CONFIG_KEY_CANARY),
  },
  {
    // Injected into a DOC rather than into source: the check scans both, and
    // a doc is the surface it exists for — the ninety references it found
    // were overwhelmingly prose, and the two in CLI help strings were the
    // ones an operator actually followed.
    name: "lint:retired-paths",
    command: "node scripts/lint-retired-paths.mjs",
    files: ["docs/architecture/00-overview.md"],
    inject: () =>
      append("docs/architecture/00-overview.md", `\nMappers live in ${RETIRED_PATH_CANARY}.\n`),
    assertInjected: () => read("docs/architecture/00-overview.md").includes(RETIRED_PATH_CANARY),
  },
  {
    // Injected by renaming a real package rather than by adding a fixture
    // one: the check derives what a package MUST be called from where it
    // sits, so a fixture would have to be planted at a real path anyway, and
    // renaming in place is the fault as it actually occurs -- somebody
    // reaches for a name at the moment they create the package.
    //
    // `libs/governance` is the sharpest choice available. It is the package
    // ADR-0007 names first when it explains what the prefix had come to
    // mean: `shared-policy` was one of four different architectural layers
    // wearing one badge.
    name: "lint:package-name-congruence",
    command: "node scripts/lint-package-name-congruence.mjs",
    files: ["libs/governance/package.json"],
    inject: () => {
      const file = "libs/governance/package.json";
      write(file, read(file).replace('"@polaris/governance"', `"${PACKAGE_NAME_CANARY}"`));
    },
    assertInjected: () => read("libs/governance/package.json").includes(PACKAGE_NAME_CANARY),
  },
  {
    // The mirror of the congruence gate above: law one says a library sits
    // where its name says, law two says which way an import may point.
    //
    // Injected into `libs/bus` — infrastructure — as an import of
    // `@polaris/governance`, which is domain. That is the wall the six-kind
    // tree claims exists and the one nothing else in the repository checks:
    // the edge typechecks, the tests stay green, and it reviews as ordinary
    // work.
    //
    // A side-effect import, so the fault carries no symbol. The canaries above
    // are assembled from fragments because `lint-dead-exports` and
    // `lint-env-example` search `scripts/` and would read a literal here as a
    // use; this gate cannot make that mistake in either direction — it scans
    // the six-kind roots and not `scripts/`, and there is no symbol to see.
    //
    // `@polaris/bus -> @polaris/governance` is deliberately an edge the
    // baseline does not carry. A banked edge would inject cleanly and prove
    // nothing, which is the same shape as a blind gate.
    name: "lint:import-direction",
    command: "node scripts/lint-import-direction.mjs",
    files: [SCRATCH],
    inject: () => append(SCRATCH, '\nimport "@polaris/governance";\n'),
    assertInjected: () => read(SCRATCH).includes('import "@polaris/governance"'),
  },
  {
    // Injected into the blueprint's own manifest rather than into a fixture:
    // the check reads DECLARED specifiers, and the fault as it actually
    // occurs is a specifier a move left behind. `01-storefront` is the only
    // blueprint there is, so it is also the only place the fault can go.
    name: "lint:blueprint-links",
    command: "node scripts/lint-blueprint-links.mjs",
    files: ["blueprints/01-storefront/package.json"],
    inject: () => {
      const file = "blueprints/01-storefront/package.json";
      write(file, read(file).replace('"link:../../sdks/node"', `"${BLUEPRINT_LINK_CANARY}"`));
    },
    assertInjected: () =>
      read("blueprints/01-storefront/package.json").includes(BLUEPRINT_LINK_CANARY),
  },
  {
    // Injected by rewriting the manifest rather than by a string replace of
    // the version: a replace spells the root's pin here as a second copy of
    // it, and the day the root moves the injection silently stops landing.
    // The field is set to a version that is simply not the root's, whatever
    // the root's happens to be.
    name: "lint:blueprint-pnpm",
    command: "node scripts/lint-blueprint-pnpm.mjs",
    files: ["blueprints/01-storefront/package.json"],
    inject: () => {
      const file = "blueprints/01-storefront/package.json";
      const manifest = JSON.parse(read(file));
      manifest.packageManager = BLUEPRINT_PNPM_CANARY;
      write(file, `${JSON.stringify(manifest, null, 2)}\n`);
    },
    assertInjected: () =>
      read("blueprints/01-storefront/package.json").includes(BLUEPRINT_PNPM_CANARY),
  },
  {
    name: "lint:metric-names (dashboard)",
    command: "node scripts/lint-metric-names.mjs",
    files: ["infra/grafana/dashboards/polaris-ingestion.json"],
    inject: () => {
      const file = "infra/grafana/dashboards/polaris-ingestion.json";
      const dashboard = JSON.parse(read(file));
      // The first panel is a text panel with no targets — injecting there
      // silently does nothing, which is how this entry first "passed".
      const panel = dashboard.panels.find((candidate) => candidate.targets);
      panel.targets[0].expr = "sum(rate(polaris_invented_canary_total[5m]))";
      write(file, JSON.stringify(dashboard, null, 2));
    },
    assertInjected: () =>
      read("infra/grafana/dashboards/polaris-ingestion.json").includes(
        "polaris_invented_canary_total",
      ),
  },
  {
    name: "lint:metric-names (alert rule)",
    command: "node scripts/lint-metric-names.mjs",
    files: ["infra/prometheus/rules/polaris.alerts.yml"],
    inject: () =>
      write(
        "infra/prometheus/rules/polaris.alerts.yml",
        read("infra/prometheus/rules/polaris.alerts.yml").replace(
          "polaris_ingest_violation_dropped_total",
          "polaris_invented_alert_canary_total",
        ),
      ),
    assertInjected: () =>
      read("infra/prometheus/rules/polaris.alerts.yml").includes(
        "polaris_invented_alert_canary_total",
      ),
  },
  {
    name: "lint:manifest-drift (families)",
    command: "node scripts/lint-manifest-drift.mjs",
    files: ["async/computation/sessionizer/v1/processor.manifest.yaml"],
    inject: () =>
      write(
        "async/computation/sessionizer/v1/processor.manifest.yaml",
        read("async/computation/sessionizer/v1/processor.manifest.yaml").replace(
          "- family: session.events",
          "- family: attribution.events",
        ),
      ),
    assertInjected: () =>
      read("async/computation/sessionizer/v1/processor.manifest.yaml").includes(
        "attribution.events",
      ),
  },
  {
    name: "lint:manifest-drift (test loads own version)",
    command: "node scripts/lint-manifest-drift.mjs",
    files: ["async/computation/sessionizer/v2/test/manifest.test.ts"],
    inject: () =>
      write(
        "async/computation/sessionizer/v2/test/manifest.test.ts",
        read("async/computation/sessionizer/v2/test/manifest.test.ts").replace(
          'version: "v2",',
          'version: "v1",',
        ),
      ),
    assertInjected: () =>
      read("async/computation/sessionizer/v2/test/manifest.test.ts").includes('version: "v1",'),
  },
  {
    name: "lint:env-example",
    command: "node scripts/lint-env-example.mjs",
    files: [".env.example"],
    inject: () => append(".env.example", `\n${ENV_DOC_CANARY}=1\n`),
    assertInjected: () => read(".env.example").includes(ENV_DOC_CANARY),
  },
  {
    // Injected into `.dockerignore`, not into a Dockerfile: the exclusion is
    // the half that moved. Re-adding the one word that made two images
    // unbuildable for six days is the exact fault, and `assertInjected` looks
    // for a BARE `definitions` line because the file now explains the word at
    // length in comments -- an `includes("definitions")` would hold before the
    // injection and prove nothing.
    name: "lint:docker-context",
    command: "node scripts/lint-docker-context.mjs",
    files: [".dockerignore"],
    inject: () => append(".dockerignore", `\n${DOCKER_CONTEXT_CANARY}\n`),
    assertInjected: () =>
      read(".dockerignore")
        .split("\n")
        .some((line) => line === DOCKER_CONTEXT_CANARY),
  },
  {
    // Injected into pnpm-workspace.yaml rather than into a Dockerfile, because
    // the fault is the repository-level fact the Dockerfiles depend on and
    // cannot see: `pnpm deploy` refuses to run at all without injection, so
    // every builder stage that ends in `pnpm deploy --prod /deploy` fails on a
    // file none of them mention. That is the founding bug -- seventeen images
    // unbuildable from the day the runtime moved to pnpm v10, found three
    // times by cards doing something else, because nothing in CI built an
    // image and nothing in the gate read this line.
    //
    // Confirmed to be the fault rather than a likeness of it: with the
    // declaration commented out, `pnpm --filter "@polaris/..." deploy --prod`
    // exits on ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE, the same error the
    // builder stage hits. The check reports both halves of its first rule --
    // the declaration is gone AND `pnpm config get` resolves to `undefined`.
    name: "lint:docker-deploy",
    command: "node scripts/lint-docker-deploy.mjs",
    files: ["pnpm-workspace.yaml"],
    inject: () =>
      write(
        "pnpm-workspace.yaml",
        read("pnpm-workspace.yaml").replace(DEPLOY_INJECTION_LINE, `# ${DEPLOY_INJECTION_LINE}`),
      ),
    // Two clauses, because each answers a different question. The first is
    // that the mutation ran; the second is that the manifest now declares
    // nothing, which is what has to hold for the gate's verdict to mean
    // anything. The file discusses the setting at length in comments, so
    // neither clause can be an `includes`.
    assertInjected: () => {
      const lines = read("pnpm-workspace.yaml").split("\n");
      return (
        lines.some((line) => line.trim() === `# ${DEPLOY_INJECTION_LINE}`) &&
        !lines.some((line) => line.startsWith(DEPLOY_INJECTION_LINE))
      );
    },
  },
  {
    // The fault this whole card is about, re-created exactly: a group gate
    // that runs four of CI's five checks. `format:check` was the missing one,
    // the group went green on every card, and `main` turned red on the push
    // that landed it.
    //
    // The injection REMOVES rather than plants, like the deploy-injection
    // canary above and for the same reason -- a subset gate is an absence,
    // and planting a foreign gate would prove the mirror rule instead of the
    // one that has actually bitten this repository.
    name: "lint:gate-parity",
    command: "node scripts/lint-gate-parity.mjs",
    files: ["package.json"],
    inject: () => write("package.json", read("package.json").replace(GATE_PARITY_INJECTION, "")),
    // Read out of the parsed `verify` script, not off the file. The string
    // `format:check` also names the script that DEFINES the gate, which the
    // injection leaves alone -- so an `includes` on the source would report
    // an injection that never landed as landed.
    assertInjected: () => {
      const verify = JSON.parse(read("package.json")).scripts?.verify ?? "";
      return !verify.includes("format:check");
    },
  },
  {
    name: "openapi:check",
    command: "pnpm openapi:check",
    files: ["docs/api/openapi.json"],
    inject: () => {
      const spec = JSON.parse(read("docs/api/openapi.json"));
      spec.info.title = `${spec.info.title} CANARY`;
      write("docs/api/openapi.json", JSON.stringify(spec, null, 2));
    },
    assertInjected: () => read("docs/api/openapi.json").includes("CANARY"),
  },
];

/**
 * Gates that need a live service, and so cannot run in static analysis.
 *
 * Kept as a separate roster rather than a flag on each entry, because the
 * default run has to stay service-free: a harness that silently skipped
 * three gates when nothing was listening would be the same "green for no
 * work" this script exists to refuse. `--with-services` opts in, and
 * `integration.yml` is where that happens.
 */
const SERVICE_GATES = [
  {
    // A trait selecting a column the projection does not have. This is the
    // gate's founding bug: `orders_30d` selected `profile_id` and filtered on
    // `day` against a table with neither, the trait had never run, and the
    // table-name lint passed because the table name was right.
    name: "check:catalog-sql (needs ClickHouse)",
    command: "node scripts/check-catalog-sql.mjs --require-clickhouse",
    files: ["definitions/traits/orders-30d.ts"],
    // A column added to the SELECT LIST, not a second SELECT. The first
    // attempt spliced `SELECT <canary> FROM ...` in front of the FROM, which
    // ClickHouse rejects as a syntax error at position 90 — so the gate went
    // red for parsing rather than for resolution, and would have gone red
    // under `EXPLAIN SYNTAX` too. That is the exact weaker check this gate
    // exists to replace, so the injection would have proven nothing about it.
    inject: () =>
      write(
        "definitions/traits/orders-30d.ts",
        read("definitions/traits/orders-30d.ts").replace(
          "        profile_id,",
          `        profile_id,\n        ${SQL_COLUMN_CANARY},`,
        ),
      ),
    assertInjected: () => read("definitions/traits/orders-30d.ts").includes(SQL_COLUMN_CANARY),
  },
];

/**
 * Gates that need a working Docker daemon, and so cannot run in static
 * analysis either.
 *
 * Separate from SERVICE_GATES rather than merged with it because the two opt
 * in from different workflows and cost different things: a compose stack in
 * `integration.yml`, an image build in `images.yml`. `--with-docker` opts in.
 *
 * One target rather than the whole per-push set. The set is what CI runs; a
 * single image is what proves the command goes red, and injecting into a
 * Dockerfile changes the build context, so every OTHER image in the set would
 * reinstall the workspace from scratch to reach a verdict this already has.
 */
const DOCKER_GATES = [
  {
    // The fault is injected BEFORE `COPY . .`, which is deliberate and not
    // merely thrifty. Everything after that instruction depends on the build
    // context, and the injection changes the context -- so a fault planted
    // later would make the build reinstall the entire workspace before
    // reaching it, turning a seconds-long proof into a minutes-long one.
    name: "docker:build (needs Docker)",
    command: "node scripts/docker-build.mjs sync-identity",
    files: ["sync/identity/resolver/v1/Dockerfile"],
    inject: () => {
      const file = "sync/identity/resolver/v1/Dockerfile";
      write(
        file,
        read(file).replace(
          "WORKDIR /workspace\n\nCOPY . .",
          `WORKDIR /workspace\n\nCOPY ${DOCKER_BUILD_CANARY} /tmp/canary\n\nCOPY . .`,
        ),
      );
    },
    assertInjected: () =>
      read("sync/identity/resolver/v1/Dockerfile").includes(
        `COPY ${DOCKER_BUILD_CANARY} /tmp/canary`,
      ),
  },
];

function restore(files) {
  sh(`git checkout -- ${files.join(" ")}`);
}

function main() {
  if (sh("git status --porcelain").trim().length > 0) {
    console.error("verify-gates: the working tree is dirty. Restoring is `git checkout`, so this");
    console.error("refuses to run rather than risk discarding your changes.");
    process.exitCode = 1;
    return;
  }

  const roster = [
    ...GATES,
    ...(process.argv.includes("--with-services") ? SERVICE_GATES : []),
    ...(process.argv.includes("--with-docker") ? DOCKER_GATES : []),
  ];

  const blind = [];
  const unlanded = [];
  const alreadyRed = [];
  for (const gate of roster) {
    // Green BEFORE the fault, or "fails as it should" means nothing.
    //
    // A gate that is already failing on a clean tree fails again with the
    // fault injected, and this harness reported it verified. That is not
    // hypothetical: adding `lint:retired-paths` to this roster made the
    // harness itself carry a retired path as a literal canary, the gate went
    // permanently red, and it still printed "fails as it should". The whole
    // claim of this script is that a gate answers DIFFERENTLY with and
    // without the fault, and only one of those two answers was being read.
    try {
      sh(gate.command);
    } catch {
      alreadyRed.push(gate.name);
      console.log(`  ALREADY FAILING, not tested  ${gate.name}`);
      continue;
    }
    gate.inject();
    if (!gate.assertInjected()) {
      unlanded.push(gate.name);
      restore(gate.files);
      continue;
    }
    let failed = false;
    try {
      sh(gate.command);
    } catch {
      failed = true;
    }
    restore(gate.files);
    if (!failed) blind.push(gate.name);
    console.log(`  ${failed ? "fails as it should" : "PASSED WITH THE FAULT"}  ${gate.name}`);
  }

  if (alreadyRed.length > 0) {
    console.error("\nverify-gates: these gates were red on a clean tree, so injecting a fault");
    console.error("proves nothing about them:");
    for (const name of alreadyRed) console.error(`  ${name}`);
    console.error("Fix the gate first, then re-run.");
    process.exitCode = 1;
  }

  if (unlanded.length > 0) {
    console.error("\nverify-gates: an injection did not land, so these gates were not tested:");
    for (const name of unlanded) console.error(`  ${name}`);
    console.error("Fix the injection. An unlanded fault looks exactly like a blind gate.");
    process.exitCode = 1;
  }
  if (blind.length > 0) {
    console.error("\nverify-gates: these gates did NOT notice a fault they exist to catch:");
    for (const name of blind) console.error(`  ${name}`);
    process.exitCode = 1;
    return;
  }
  // Only claim the full roster when the full roster was actually tested. A
  // run that skipped a gate — because its injection did not land, or because
  // it was already red — printed the same success line as a clean run, which
  // is the failure this script exists to refuse in the checks it polices.
  const skipped = unlanded.length + alreadyRed.length;
  if (skipped === 0) {
    console.log(`\nverify-gates: all ${String(roster.length)} gates fail when they should.`);
    return;
  }
  console.error(
    `\nverify-gates: ${String(roster.length - skipped)} of ${String(roster.length)} gates ` +
      `tested; ${String(skipped)} skipped and proven nothing.`,
  );
  process.exitCode = 1;
}

main();
