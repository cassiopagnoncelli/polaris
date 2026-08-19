/**
 * The five destination manifests, and the code they claim to describe.
 *
 * Two gaps, both found while auditing the pipeline redesign against the
 * shipped tree.
 *
 * **Nothing parsed a `consumer.manifest.yaml` at all.** Not a loader, not
 * a schema, not a lint — `lint-manifest-drift.mjs` reads two keys out of
 * them textually and nothing else does anything. The processor manifests
 * had the same hole and two of them turned out to be invalid; these five
 * had never been checked against any shape.
 *
 * **`required_consent` is written twice.** The manifest declares it for a
 * human, and the descriptor declares it for the gate. The manifest is what
 * an operator reads to answer "what consent does this vendor need", and
 * the descriptor is what actually drops the event — so a manifest that
 * drifted would be wrong about a compliance question while every test
 * stayed green. `identity_hashing` is the same fact written twice for the
 * same reason.
 *
 * The plan's §6 promised "consent requirements as config values". What
 * shipped lets a project require MORE than its vendor does and never less,
 * because a config row that could relax a vendor's requirement would let a
 * database write undo a compliance decision made in code. That narrowing
 * is deliberate and stays; what was missing is anything keeping the two
 * hard-coded copies of the vendor's own requirement honest.
 *
 * Read textually rather than imported, like `lint-manifest-drift.mjs`:
 * importing five vendor packages would mean building the workspace to run
 * a check, and a check that needs a build is one that gets skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DESTINATIONS = join(ROOT, "sync", "destinations");

const versionSchema = z.string().regex(/^v[0-9]+(\.[0-9]+){0,2}$/u);
const consentDimensionSchema = z.object({
  marketing: z.boolean(),
  analytics: z.boolean(),
  personalization: z.boolean(),
});

/**
 * The shape every `consumer.manifest.yaml` holds.
 *
 * `.strict()`, so a typo'd key fails rather than being silently ignored —
 * which is exactly how `required_consent: {}` ended up on two PROCESSOR
 * manifests, where the key does not exist.
 *
 * `vendor` is not required to equal `name`: webhook-sink's vendor is
 * `webhook`, because the vendor is what the delivery record names and the
 * unit is what the directory names.
 */
const consumerManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/u),
    version: versionSchema,
    vendor: z.string().regex(/^[a-z][a-z0-9_-]{1,62}[a-z0-9]$/u),
    vendor_api_version: z.string().min(1).max(32),
    owner: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(8192),
    inputs: z.array(z.string().regex(/^[a-z][a-z.]*\.[a-z]+$/u)).min(1),
    // Empty by definition: a destination's output is a vendor API call and
    // a `delivery_records` row, not an event family.
    outputs: z.array(z.string()).max(0),
    state_stores: z.array(z.string().regex(/^[a-z]+:[a-z_]+$/u)),
    mode: z.enum(["streaming", "batch"]),
    normalize_version: versionSchema,
    mapper_version: versionSchema,
    deliverer_version: versionSchema,
    required_consent: consentDimensionSchema,
    identity_hashing: z.object({ email: z.boolean(), phone: z.boolean() }),
    dlq_topic_family: z.string().min(1),
    defaults: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Every destination unit that ships a consumer manifest. */
function findConsumerManifests(): ReadonlyArray<{ vendorDir: string; unitDir: string }> {
  const found: Array<{ vendorDir: string; unitDir: string }> = [];
  for (const vendorDir of readdirSync(DESTINATIONS).sort()) {
    if (vendorDir.startsWith(".")) continue;
    let versions: string[];
    try {
      versions = readdirSync(join(DESTINATIONS, vendorDir));
    } catch {
      continue;
    }
    for (const version of versions.sort()) {
      if (!/^v\d+$/.test(version)) continue;
      found.push({ vendorDir, unitDir: join(DESTINATIONS, vendorDir, version) });
    }
  }
  return found;
}

const MANIFESTS = findConsumerManifests();

/**
 * The consent object a descriptor declares, read out of its source.
 *
 * Matches `const REQUIRED_CONSENT: RequiredConsent = Object.freeze({...})`
 * and normalises an omitted dimension to `false` — the gate's
 * `evaluateConsent` treats absent as not-required, so `{ marketing: true }`
 * and `{ marketing: true, analytics: false }` are the same declaration.
 */
function descriptorConsent(unitDir: string): Record<string, boolean> {
  const source = readFileSync(join(unitDir, "src", "descriptor.ts"), "utf8");
  const match = /REQUIRED_CONSENT[^=]*=\s*Object\.freeze\(\{([^}]*)\}\)/.exec(source);
  if (match === null) throw new Error(`no REQUIRED_CONSENT in ${unitDir}/src/descriptor.ts`);
  const out: Record<string, boolean> = {
    marketing: false,
    analytics: false,
    personalization: false,
  };
  for (const pair of match[1].matchAll(/(\w+)\s*:\s*(true|false)/g)) {
    out[pair[1] as string] = pair[2] === "true";
  }
  return out;
}

/** The same, for `IDENTITY_HASHING`. */
function descriptorHashing(unitDir: string): Record<string, boolean> {
  const source = readFileSync(join(unitDir, "src", "descriptor.ts"), "utf8");
  const match = /IDENTITY_HASHING[^=]*=\s*Object\.freeze\(\{([^}]*)\}\)/.exec(source);
  if (match === null) throw new Error(`no IDENTITY_HASHING in ${unitDir}/src/descriptor.ts`);
  const out: Record<string, boolean> = { email: false, phone: false };
  for (const pair of match[1].matchAll(/(\w+)\s*:\s*(true|false)/g)) {
    out[pair[1] as string] = pair[2] === "true";
  }
  return out;
}

function manifestOf(unitDir: string): z.infer<typeof consumerManifestSchema> {
  return consumerManifestSchema.parse(
    parseYaml(readFileSync(join(unitDir, "consumer.manifest.yaml"), "utf8")),
  );
}

describe("every consumer manifest", () => {
  it("finds all five", () => {
    // Guards the guard: an empty list makes every `it.each` below vacuous
    // and this suite reports green having checked nothing.
    expect(MANIFESTS.map((m) => m.vendorDir)).toEqual([
      "braze",
      "ga4",
      "meta-capi",
      "tiktok",
      "webhook-sink",
    ]);
  });

  it.each(MANIFESTS.map((m) => [m.vendorDir, m.unitDir]))("%s parses", (vendor, unitDir) => {
    const parsed = consumerManifestSchema.safeParse(
      parseYaml(readFileSync(join(unitDir, "consumer.manifest.yaml"), "utf8")),
    );
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    expect(issues, `${vendor} does not parse`).toEqual([]);
  });

  it.each(MANIFESTS.map((m) => [m.vendorDir, m.unitDir]))(
    "%s declares the version its directory claims",
    (_vendor, unitDir) => {
      expect(manifestOf(unitDir).version).toBe(unitDir.split("/").pop());
    },
  );
});

describe("the manifest agrees with the descriptor", () => {
  it.each(MANIFESTS.map((m) => [m.vendorDir, m.unitDir]))(
    "%s: required_consent matches what the gate enforces",
    (vendor, unitDir) => {
      // The compliance question, written in two places. The manifest is
      // what an operator reads; the descriptor is what drops the event.
      expect(manifestOf(unitDir).required_consent, `${vendor} manifest disagrees`).toEqual(
        descriptorConsent(unitDir),
      );
    },
  );

  it.each(MANIFESTS.map((m) => [m.vendorDir, m.unitDir]))(
    "%s: identity_hashing matches what normalize is told",
    (vendor, unitDir) => {
      expect(manifestOf(unitDir).identity_hashing, `${vendor} manifest disagrees`).toEqual(
        descriptorHashing(unitDir),
      );
    },
  );

  it.each(MANIFESTS.map((m) => [m.vendorDir, m.unitDir]))(
    "%s: the DLQ family names this vendor and version",
    (_vendor, unitDir) => {
      const manifest = manifestOf(unitDir);
      expect(manifest.dlq_topic_family).toBe(
        `destination.${manifest.name}.${manifest.version}.dlq`,
      );
    },
  );
});
