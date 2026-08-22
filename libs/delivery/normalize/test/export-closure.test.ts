/**
 * The package's public surface must be closed: a type a consumer can name
 * from the root must have every type IT names available from the root too.
 *
 * `RawIdentityInput` gained `extends RawPersonMatchKeys, RawAddressMatchKeys`
 * and neither base left the package. Inside it that is invisible — every
 * other test here imports `../src/x.js` relatively, and a relative import
 * resolves whatever `index.ts` says and whatever `exports` declares. Only a
 * consumer reads either, so only a consumer failed: the Meta mapper's geo
 * fallback called `prepareIdentity({ city, state, country })` and got
 * `TS2353: 'city' does not exist in type 'RawIdentityInput'`, naming a
 * property the interface plainly inherits.
 *
 * That is the general lesson and the reason this file exists: a package's
 * own tests never exercise its export map. So this one does, two ways.
 *
 *   - The imports below go through `@polaris/delivery-normalize` and its
 *     subpaths — the specifiers a consumer writes — rather than through
 *     `../src/`. They are `import type`, so `verbatimModuleSyntax` erases
 *     them and vitest never resolves them; `tsc -p tsconfig.tests.json`
 *     does, which is where a missing export becomes a failure. On the tree
 *     before the fix this file did not compile.
 *   - The assertions then generalise it, because the next instance will
 *     not be these two types. They read `index.ts` and `package.json` and
 *     hold two rules over whatever the package grows into.
 *
 * The second rule is about `exports` rather than about naming, and it is
 * not symmetry for its own sake. `scripts/sync-injected-workspace-copies.mjs`
 * decides whether an injected copy is stale by comparing the copy against
 * the entrypoints its manifest declares — so a module on neither surface
 * can be absent from a copy while the check reports every copy in sync.
 * That is how the failure above reached a gate at all: pnpm hard-links the
 * copy, `tsc` rewrote `dist/identity.d.ts` in place so the copy silently
 * gained the new `extends`, and `dist/person.d.ts` and `dist/address.d.ts`
 * were new files it never gained. Undeclared modules cannot go stale
 * loudly.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NormalizedAddressMatchKeys,
  NormalizedPersonMatchKeys,
  RawAddressMatchKeys,
  RawIdentityInput,
  RawPersonMatchKeys,
} from "@polaris/delivery-normalize";
import type { NormalizedAddressMatchKeys as AddressViaSubpath } from "@polaris/delivery-normalize/address";
import type { NormalizedPersonMatchKeys as PersonViaSubpath } from "@polaris/delivery-normalize/person";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The geo fallback that failed, written against the root surface.
 *
 * Three of the eight extended keys and none of the four identifiers, which
 * is what makes it the case that broke: every property here is inherited,
 * so an `extends` the consumer cannot resolve leaves the literal with three
 * excess properties rather than with a missing one.
 */
const geoFallback: RawIdentityInput = { city: "São Paulo", state: "SP", country: "BR" };

/** Both halves of the raw set, reachable from the root a consumer imports. */
const rawMatchKeys: RawPersonMatchKeys & RawAddressMatchKeys = {
  first_name: "José",
  postal_code: "94025-1234",
};

/**
 * The normalized counterparts, named through both surfaces at once.
 *
 * The aliased subpath imports are the assertion: a type that is the same
 * type through `@polaris/delivery-normalize` and through
 * `@polaris/delivery-normalize/person` is one declaration reached two ways,
 * and assigning across them would not compile if a subpath resolved to a
 * second copy or to nothing.
 */
const normalizedPerson: NormalizedPersonMatchKeys = {
  first_name: null,
  last_name: null,
  gender: null,
  birthday: null,
};
const normalizedAddress: NormalizedAddressMatchKeys = {
  city: null,
  state: null,
  postal_code: null,
  country: null,
};
const personViaSubpath: PersonViaSubpath = normalizedPerson;
const addressViaSubpath: AddressViaSubpath = normalizedAddress;

/**
 * Names `index.ts` re-exports, and the module each one comes from.
 *
 * Read as text rather than by importing the module, because half of what
 * this file is about is types, and a type has no runtime name to look up.
 * `test/public-surface.test.ts` covers the runtime half by import.
 */
function rootSurface(): { names: Set<string>; modules: Set<string> } {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "index.ts"), "utf8");
  const names = new Set<string>();
  const modules = new Set<string>();
  for (const [, clause, module] of source.matchAll(
    /export\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+)\.js";/g,
  )) {
    modules.add(module as string);
    for (const entry of (clause as string).split(",")) {
      // `type Foo`, `Foo as Bar` — the exported name is the last word.
      const name = entry.trim().split(/\s+/).pop();
      if (name !== undefined && name.length > 0) names.add(name);
    }
  }
  return { names, modules };
}

/**
 * Every `extends` clause on an exported interface or class in `src/`.
 *
 * Text again, and deliberately not the TypeScript compiler API: this
 * package does not depend on `typescript` and a guard that reaches for the
 * root's copy through hoisting is one that breaks the day hoisting changes.
 * The cost is that the scan is only as good as the shapes it knows, which
 * is what the `finds what is there` case below exists to hold — a scan that
 * quietly matched nothing would pass every other assertion in this file.
 */
function publicHeritage(module: string): { name: string; bases: string[] }[] {
  const source = readFileSync(join(PACKAGE_ROOT, "src", `${module}.ts`), "utf8");
  const found: { name: string; bases: string[] }[] = [];
  for (const [, name, clause] of source.matchAll(
    /^export\s+(?:abstract\s+)?(?:interface|class)\s+([\w$]+)[^{]*?\bextends\s+([^{]+)\{/gm,
  )) {
    const bases = (clause as string)
      // `class X extends Y implements Z` — only the `extends` half is the
      // question here, and the rest of the clause is not a base name.
      .replace(/\bimplements\b[\s\S]*$/, "")
      .split(",")
      .map((base) => base.trim().replace(/<.*$/s, "").trim())
      .filter((base) => base.length > 0);
    found.push({ name: name as string, bases });
  }
  return found;
}

/** The subpaths `package.json` declares, as module names: `./person` -> `person`. */
function declaredSubpaths(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
  };
  return new Set(
    Object.keys(manifest.exports)
      .filter((subpath) => subpath !== ".")
      .map((subpath) => subpath.replace(/^\.\//, "")),
  );
}

describe("the root surface is closed under `extends`", () => {
  it("finds what is there, so a scan that found nothing could not pass", () => {
    // The instance this file was written for. If `identity.ts` stops
    // spelling it this way the guard has to learn the new spelling, which
    // is the point: silence here would otherwise read as compliance.
    expect(publicHeritage("identity")).toContainEqual({
      name: "RawIdentityInput",
      bases: ["RawPersonMatchKeys", "RawAddressMatchKeys"],
    });
  });

  it("exports every type a public `extends` names", () => {
    const { names, modules } = rootSurface();
    const leaked: string[] = [];
    for (const module of modules) {
      for (const { name, bases } of publicHeritage(module)) {
        if (!names.has(name)) continue; // not on the public surface
        for (const base of bases) {
          if (!names.has(base)) leaked.push(`${module}.ts: ${name} extends ${base}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});

describe("both surfaces name the same modules", () => {
  it("declares a subpath for every module the root re-exports", () => {
    const { modules } = rootSurface();
    expect([...declaredSubpaths()].sort()).toEqual([...modules].sort());
  });
});

describe("the types a consumer reaches through the package name", () => {
  it("carries the extended match keys `RawIdentityInput` inherits", () => {
    expect(geoFallback).toEqual({ city: "São Paulo", state: "SP", country: "BR" });
    expect(rawMatchKeys.first_name).toBe("José");
  });

  it("resolves one declaration through the root and through the subpath", () => {
    expect(personViaSubpath).toBe(normalizedPerson);
    expect(addressViaSubpath).toBe(normalizedAddress);
  });
});
