/**
 * The retired-path check finds what a careful sweep did not.
 *
 * The R-programme move deleted `processors/` and `consumers/` and replaced
 * the fan-out with a chained spine. A docs pass followed and edited the
 * files somebody remembered; an audit weeks later found ninety more
 * references, including `polaris destinations --help` telling an operator
 * where mapper code lives and naming a directory that no longer existed.
 *
 * The sweep was not the fix — this check is. So the check itself has to be
 * worth trusting, which is what these assertions are for: each rule is
 * shown finding a real violation AND leaving a correct line alone, because
 * a pattern that matches everything and a pattern that matches nothing both
 * report a clean tree.
 *
 * The `PAST_TENSE` cases are the ones worth reading. A test asserting
 * `isCanonicalStreamFamily("enriched.events")` is `false` must NAME the
 * retired family to say anything about it, and a check that refused those
 * would push every such line into an exception list until nobody read it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findRetiredPaths, HISTORICAL, RETIRED } from "../lint-retired-paths.mjs";

describe("the rule set", () => {
  it("has a hint on every rule", () => {
    // The hint is the point: a failure should not send anybody to `git log`
    // to find out what the path became.
    for (const rule of RETIRED) {
      expect(rule.hint, `${rule.id} has no hint`).toBeTruthy();
      expect(rule.hint.length).toBeGreaterThan(20);
    }
  });

  it("keeps the historical exception list short", () => {
    // Not a style rule. Every entry is a claim that a file is about the
    // past on purpose, and a list long enough to skim is one nobody reads.
    expect(HISTORICAL.size).toBeLessThanOrEqual(8);
  });
});

describe("scanning a tree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "polaris-retired-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  function scan(): ReturnType<typeof findRetiredPaths> {
    return findRetiredPaths(root);
  }

  it("finds a retired processor directory", () => {
    write("docs/x.md", "Manifests live at `processors/<name>/v<n>/processor.manifest.yaml`.\n");
    expect(scan().map((p) => p.rule)).toContain("processors-dir");
  });

  it("finds a retired consumer directory", () => {
    write("apps/y.ts", "// mappers live in consumers/<vendor>/v<n>/mappers/\n");
    expect(scan().map((p) => p.rule)).toContain("consumers-dir");
  });

  it("finds a reintroduced catalog location", () => {
    write("docs/x.md", "Trait registries live at `catalog/traits/`.\n");
    expect(scan().map((p) => p.rule)).toContain("catalog-dir");
  });

  it("finds a catalog location quoted as a builder path", () => {
    // The shape the docker-context bug had. A rule that refused every
    // `/`-prefixed match in order to protect the modules below would have
    // called this clean.
    write("docs/y.md", "The image runs `COPY --from=builder /workspace/catalog/projects`.\n");
    expect(scan().map((p) => p.rule)).toContain("catalog-dir");
  });

  it("leaves the modules named for the event-catalog concept alone", () => {
    // Why the rule names eight directories instead of `catalog/`. These
    // three modules keep the name because it is the CONCEPT they implement,
    // not the directory 0DIPB renamed, and a bare `catalog/` pattern would
    // fail every import of them.
    write(
      "apps/polaris-cli/src/commands/projects/list.ts",
      'import { loadCatalog, resolveCatalogRoot } from "../../catalog/index.js";\n',
    );
    write("apps/ingester-api/src/app.ts", 'import { loadRuntimeCatalog } from "./catalog/runtime.js";\n');
    write("libs/spec/src/index.ts", 'export * from "./catalog/index.js";\n');
    expect(scan()).toEqual([]);
  });

  it("leaves a word-ish prefix alone, and the directory's new name", () => {
    write("docs/ok-catalog.md", "A registry could live at `libs/event-catalog/events/`.\n");
    write("docs/ok-defs.md", "Declared content lives at `definitions/traits/`.\n");
    expect(scan()).toEqual([]);
  });

  it("finds a reintroduced sql location", () => {
    write("docs/x.md", "ClickHouse DDL lives at `sql/clickhouse/roles/`.\n");
    expect(scan().map((p) => p.rule)).toContain("sql-dir");
  });

  it("finds the directory named bare, with no child to anchor to", () => {
    // The shape `getting-started.md` and `ci.md` both had: the location in a
    // list of locations. A rule anchored to `sql/clickhouse` the way
    // `catalog-dir` is anchored to its kinds would have called these clean.
    write("docs/y.md", "It walks `apps/`, `sql/`, `db/`, and `tests/`.\n");
    expect(scan().map((p) => p.rule)).toContain("sql-dir");
  });

  it("leaves the other SQLs alone", () => {
    // Why the lookbehind refuses a word-ish prefix. Nothing in the tree is
    // named `sql`, but plenty of things END in it.
    write("docs/ok-sql.md", "See `mysql/`, `postgresql/` and `graphql/` for the dialects.\n");
    write("docs/ok-db.md", "ClickHouse DDL lives at `db/clickhouse/roles/`.\n");
    expect(scan()).toEqual([]);
  });

  it("finds the migrations directory at its old depth", () => {
    write("docs/w.md", "Author the migration in `db/migrations/`.\n");
    expect(scan().map((p) => p.rule)).toContain("db-migrations-dir");
  });

  it("leaves the migrations directory at its new depth", () => {
    // `db/` is the storage root now, one directory per engine under it. The
    // lookbehind is what keeps a longer path off the rule.
    write("docs/ok-pg.md", "Author the migration in `db/postgres/migrations/`.\n");
    write("docs/ok-lib.md", "dbmate is a devDependency of `libs/persistence/postgres/`.\n");
    expect(scan()).toEqual([]);
  });

  it("finds the fan-out sentence", () => {
    write("docs/z.md", "Processors fan out from `raw.events` rather than chaining.\n");
    expect(scan().map((p) => p.rule)).toContain("fan-out-model");
  });

  it("finds the retired family", () => {
    write("libs/a/src/b.ts", "/** routes enriched.events to the processed queue */\n");
    expect(scan().map((p) => p.rule)).toContain("enriched-events-family");
  });

  it("reports the file and line, not just a count", () => {
    write("docs/x.md", "ok\nok\nSee `processors/<name>/v1/`.\n");
    const [problem] = scan();
    expect(problem?.file).toBe("docs/x.md");
    expect(problem?.line).toBe(3);
  });

  it("leaves the current layout alone", () => {
    write(
      "docs/ok.md",
      [
        "Units live at `{sync,async}/<stage>/<name>/<version>/`.",
        "Destinations are `sync/destinations/<vendor>/<version>/`.",
        "The spine chains: raw.events -> identified.events -> resolved.events.",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("leaves a line that says the thing is GONE alone", () => {
    // The case that keeps the exception list short. Each of these has to
    // name the retired thing in order to say anything true about it.
    write(
      "libs/a/test/b.test.ts",
      [
        'expect(isCanonicalStreamFamily("enriched.events")).toBe(false);',
        "// `enriched.events` was retired with the fan-out.",
        "// The enriched family is no longer provisioned.",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("skips applied migrations, which are a record and not a claim", () => {
    // Editing one to satisfy a lint would falsify the history it exists to
    // keep -- `20260818000001_retire_fan_out_topic_families.sql` names the
    // families because deleting them is its subject.
    write("db/postgres/migrations/20260818000001_retire.sql", "-- drops enriched.events\n");
    expect(scan()).toEqual([]);
  });

  it("finds the location ADR-0007 emptied", () => {
    write("docs/x.md", "The pool is configured in `packages/shared-db/src/database.ts`.\n");
    expect(scan().map((p) => p.rule)).toContain("packages-dir");
  });

  it("finds the directory named bare, in a list of directories", () => {
    // The docs shape, and the reason the rule does not require a child.
    // `ci.md` had exactly this line, naming four roots and one dead one.
    write("docs/y.md", "It walks `apps/`, `packages/`, `sync/` and `db/`.\n");
    expect(scan().map((p) => p.rule)).toContain("packages-dir");
  });

  it("names the new directory AND the new package, which changed separately", () => {
    // Two cards moved this package: one changed where it lives, the other
    // what it is called. A reader holding only one of the two is still stuck.
    write("docs/x.md", "See `packages/shared-service-bootstrap/src/bootstrap/health.ts`.\n");
    const hint = scan()[0]?.hint ?? "";
    expect(hint).toContain("libs/runtime/service-bootstrap/");
    expect(hint).toContain("@polaris/runtime-service-bootstrap");
  });

  it("leaves the destination roots alone", () => {
    // The complement: a rule that fired on the tree the packages moved INTO
    // would fail every corrected line the sweep just wrote.
    write(
      "apps/a/src/b.ts",
      [
        'import { pool } from "@polaris/persistence-postgres";',
        'import { bootstrap } from "@polaris/runtime-service-bootstrap";',
        "// see `libs/persistence/postgres/src/` and `sdks/web/src/`",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("leaves the English pair alone, which is not a path", () => {
    // "ESM-first packages/services" is a slash meaning "and", and three files
    // say some version of it. A rule that fired on those is a rule somebody
    // turns off, so it requires a trailing slash or a child segment.
    write("docs/ok-prose.md", "Polaris is ESM-first packages/services throughout.\n");
    write("docs/ok-prose2.md", "It will build all packages/services in one pass.\n");
    expect(scan()).toEqual([]);
  });

  it("scans the tree the libraries moved INTO", () => {
    // A root missing from SCAN_DIRS turns the check off for everything under
    // it without failing, which is how a moved page could reintroduce a
    // retired path and still pass.
    write("libs/persistence/postgres/src/a.ts", "// see processors/<name>/v1/store.ts\n");
    expect(scan().map((p) => p.rule)).toContain("processors-dir");
  });

  it("scans the blueprint tier, which nothing else in the gate opens", () => {
    // The tier sits outside `pnpm-workspace.yaml` and outside
    // `tsconfig.tests.json` by design, so a root missing from SCAN_DIRS left
    // `blueprints/` unread by anything at all. That is how the storefront came
    // to point at `packages/` for months after ADR-0007 emptied it, with every
    // gate green.
    write(
      "blueprints/01-storefront/lib/polaris-node.ts",
      "// see packages/node-sdk/src/index.ts\n",
    );
    expect(scan().map((p) => p.rule)).toContain("packages-dir");
  });

  it("scans a blueprint's prose, which is the tier's whole product", () => {
    // A blueprint is read by somebody outside the monorepo, following it
    // literally, with no `git log` to check a sentence against.
    write("blueprints/README.md", "Re-run it after editing `catalog/traits/`.\n");
    expect(scan().map((p) => p.rule)).toContain("catalog-dir");
  });

  it("does not scan generated or vendored output", () => {
    write("libs/a/dist/b.js", "// consumers/<vendor>/v<n>/mappers/\n");
    write("libs/a/node_modules/c/d.ts", "// processors/<name>/v1/\n");
    expect(scan()).toEqual([]);
  });
});
