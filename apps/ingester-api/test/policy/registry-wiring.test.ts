/**
 * The ingester's first enforcement pass must run the project's override,
 * not just the platform defaults (H0GI1EZ0).
 *
 * The machinery — `createPolicyResolver`, `mergePolicy`, the evaluator —
 * shipped complete and wired to an empty map, so every project ran
 * platform defaults no matter what its override file said. These tests
 * pin the wiring itself: the app is built WITHOUT an injected
 * `projectPolicies`, exactly as `server.ts` builds it, and the assertion
 * is on what actually reaches the producer.
 *
 * `catalog/policy/forbidden-fields.checkout.ts` is the sample override and
 * `checkout` is the test fixture's project, so the deploy-time registry is
 * exercised end to end rather than through a hand-built fixture map.
 */

import { describe, expect, it } from "vitest";

import { buildIngesterApp } from "../../src/app.js";
import { API_KEY_HEADER } from "../../src/auth/index.js";
import { InMemoryDedupeStore } from "../../src/dedupe/index.js";
import {
  buildEnvelopePayload,
  buildTestCatalog,
  InMemoryApiKeyRepository,
  RecordingProducer,
  testConfig,
} from "../fixtures.js";

/** An IBAN the checkout override's `iban_in_text` pattern detects. */
const IBAN_IN_FREE_TEXT = "DE89370400440532013000";

function repoWithKey(projectId: string): InMemoryApiKeyRepository {
  const repo = new InMemoryApiKeyRepository();
  repo.set({
    apiKeyId: "test-key-id",
    projectId,
    environment: "production",
    sourceId: "storefront-web",
    sourceType: "web",
    hash: "argon2id-hash-irrelevant-test-stub",
    hashAlgorithm: "argon2id",
    status: "active",
  });
  return repo;
}

/**
 * Build the app the way `server.ts` does — no `projectPolicies` argument.
 * That omission is the point: the override has to arrive from the
 * catalog registry the app loads for itself.
 */
async function buildApp(
  projectId: string,
  producer: RecordingProducer,
  overrides: Partial<Parameters<typeof buildIngesterApp>[0]> = {},
) {
  return buildIngesterApp({
    config: testConfig,
    installShutdown: false,
    apiKeyRepository: repoWithKey(projectId),
    catalog: buildTestCatalog(),
    producer: producer as unknown as Parameters<typeof buildIngesterApp>[0]["producer"],
    dedupe: new InMemoryDedupeStore(),
    verifyHash: async () => true,
    ...overrides,
  });
}

async function postEvent(app: Awaited<ReturnType<typeof buildIngesterApp>>["app"], title: string) {
  return app.inject({
    method: "POST",
    url: "/v1/events",
    headers: { [API_KEY_HEADER]: "test-key-id.secret" },
    payload: {
      events: [
        buildEnvelopePayload({
          properties: { path: "/checkout", search: null, title, referrer: null },
        }),
      ],
    },
  });
}

/** The `properties.title` value as it was actually published. */
function publishedTitle(producer: RecordingProducer): unknown {
  const published = producer.publishes[0]?.event as
    | { properties?: Record<string, unknown> }
    | undefined;
  return published?.properties?.title;
}

describe("ingester boot — project policy overrides load from catalog/policy", () => {
  it("applies the checkout override to an event the platform defaults would carry in the clear", async () => {
    const producer = new RecordingProducer();
    const { app } = await buildApp("checkout", producer);
    try {
      const res = await postEvent(app, IBAN_IN_FREE_TEXT);
      expect(res.statusCode).toBe(200);

      expect(producer.publishes).toHaveLength(1);
      const title = publishedTitle(producer);
      // The override's `iban_in_text` detector fired: the raw IBAN is
      // gone and the sentinel is in its place.
      expect(title).not.toBe(IBAN_IN_FREE_TEXT);
      expect(String(title)).toMatch(/^\[REDACTED:/);
    } finally {
      await app.close();
    }
  });

  it("leaves the same event untouched for a project with no override", async () => {
    // The control. Without it, a platform-default pattern that happened
    // to match would make the test above pass while the registry stayed
    // unwired — the exact failure this card exists to fix.
    const producer = new RecordingProducer();
    const { app } = await buildApp("no-override-project", producer);
    try {
      const res = await postEvent(app, IBAN_IN_FREE_TEXT);
      expect(res.statusCode).toBe(200);

      expect(producer.publishes).toHaveLength(1);
      expect(publishedTitle(producer)).toBe(IBAN_IN_FREE_TEXT);
    } finally {
      await app.close();
    }
  });

  it("an explicitly empty projectPolicies map restores platform defaults", async () => {
    // The injection seam still wins over the registry, so a test (or a
    // deployment that deliberately runs without overrides) can say so.
    const producer = new RecordingProducer();
    const { app } = await buildApp("checkout", producer, {
      projectPolicies: new Map(),
    });
    try {
      const res = await postEvent(app, IBAN_IN_FREE_TEXT);
      expect(res.statusCode).toBe(200);
      expect(publishedTitle(producer)).toBe(IBAN_IN_FREE_TEXT);
    } finally {
      await app.close();
    }
  });
});
