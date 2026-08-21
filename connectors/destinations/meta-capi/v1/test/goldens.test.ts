/**
 * Golden fixtures for the meta-capi v1 mapping: canonical event in, Meta
 * CAPI payload out.
 *
 * `docs/architecture/06-destinations.md` asks every mapper to carry a pair
 * like this, and until FLU7S the pair was hand-written prose. The outputs
 * claimed `em` and `ph` for inputs carrying no email and no phone
 * anywhere — placeholder digests standing in for field positions — so the
 * one document a reader would trust to say what Meta receives was the one
 * document nothing checked.
 *
 * Now the payload is COMPUTED, through the connector's own declarations
 * (`metaCapiConnector.map`, `.requiredConsent`, `.identityHashing`) and the
 * real `normalizeForDestination`, and the file on disk has to match it —
 * every value, and the key order too. Regenerate after an intended mapping
 * change with:
 *
 *   POLARIS_UPDATE_GOLDENS=1 pnpm --filter @polaris/destination-meta-capi-v1 test
 *   pnpm format
 *
 * and commit the diff — which is then evidence rather than noise, because
 * every line of it came out of the mapper. A second run produces the same
 * file; the digests are SHA-256 of canonical values and the key order is
 * the mapper's, so there is nothing in here for a clock or a hash seed to
 * move.
 *
 * The comparison is on the two documents SERIALIZED WITHOUT WHITESPACE,
 * which is what lets both gates own what they should. Key order and every
 * value are this test's, so a mapper that starts emitting `ct` before `db`
 * fails here. The indentation and where an array wraps are biome's, so the
 * regenerated file lands in the repository's format like every other file
 * rather than in whichever one `JSON.stringify` happens to produce.
 *
 * A fixture may carry an optional `<name>.config.json` — the instance's
 * `destinations.config` bag. Without one the instance is unconfigured,
 * which is what a fresh `polaris destinations create` produces and
 * therefore what the goldens should mostly show.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NormalizableEnvelope } from "@polaris/delivery-normalize";
import { normalizeForDestination } from "@polaris/delivery-normalize";
import { describe, expect, it } from "vitest";

import { metaCapiConnector } from "../src/connector.js";
import type { MetaCapiPayload } from "../src/types.js";
import { fixtureDestinationInstance } from "./fixtures/normalized.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Opt-in rewrite. A test's own environment reads are its business. */
const UPDATING = process.env["POLARIS_UPDATE_GOLDENS"] === "1";

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Record<string, unknown>;
}

function readConfig(name: string): Readonly<Record<string, unknown>> {
  try {
    return readJson(`${name}.config.json`);
  } catch {
    return {};
  }
}

/** Every `<name>.input.json` in the fixture directory, sorted. */
const GOLDEN_NAMES = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".input.json"))
  .map((f) => f.slice(0, -".input.json".length))
  .sort();

function mapGolden(name: string): MetaCapiPayload {
  const envelope = readJson(`${name}.input.json`) as unknown as NormalizableEnvelope;
  const instance = fixtureDestinationInstance("", readConfig(name));

  const outcome = normalizeForDestination(envelope, {
    destinationId: instance.destination_id,
    requiredConsent: metaCapiConnector.requiredConsent,
    ...(metaCapiConnector.identityHashing !== undefined
      ? { identityHashing: metaCapiConnector.identityHashing }
      : {}),
    ...(metaCapiConnector.identityFromProperties !== undefined
      ? { identityFromProperties: metaCapiConnector.identityFromProperties }
      : {}),
  });
  if (outcome.kind !== "normalized") {
    throw new Error(`${name}: normalize dropped the envelope (${outcome.reason})`);
  }

  const mapper = metaCapiConnector.map[outcome.normalized.event];
  if (mapper === undefined) {
    throw new Error(`${name}: no mapper registered for '${outcome.normalized.event}'`);
  }
  const result = mapper({ normalized: outcome.normalized, instance });
  if (result.kind !== "mapped") {
    throw new Error(`${name}: mapper skipped the event (${result.reason})`);
  }
  return result.payload;
}

describe("golden fixtures", () => {
  it("has at least one pair to check", () => {
    expect(GOLDEN_NAMES.length).toBeGreaterThan(0);
  });

  for (const name of GOLDEN_NAMES) {
    it(`${name}: the mapper produces the recorded payload`, () => {
      const payload = mapGolden(name);
      const path = join(FIXTURE_DIR, `${name}.output.json`);
      if (UPDATING) {
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      }
      const recorded: unknown = JSON.parse(readFileSync(path, "utf8"));
      expect(JSON.stringify(payload)).toBe(JSON.stringify(recorded));
    });

    it(`${name}: maps to the same payload twice`, () => {
      expect(JSON.stringify(mapGolden(name))).toBe(JSON.stringify(mapGolden(name)));
    });
  }
});
