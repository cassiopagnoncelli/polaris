/**
 * The redaction contract.
 *
 * These tests are the reason resolved secrets can live in a cache at all: they
 * assert that no ordinary serialization path yields the plaintext. The
 * sentinel is deliberately distinctive so a leak through any of them is
 * unambiguous.
 */

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/assemble.js";
import { isSecret, Secret } from "../src/secret-box.js";

const PLAINTEXT = "sk-live-NEVER-LOG-THIS-8f3a91";

describe("Secret", () => {
  it("redacts through String()", () => {
    expect(String(new Secret(PLAINTEXT))).toBe("[redacted]");
  });

  it("redacts through template interpolation", () => {
    expect(`token=${new Secret(PLAINTEXT)}`).not.toContain(PLAINTEXT);
  });

  it("redacts through JSON.stringify", () => {
    expect(JSON.stringify({ token: new Secret(PLAINTEXT) })).not.toContain(PLAINTEXT);
  });

  it("redacts through util.inspect (console.log, stack traces)", () => {
    expect(inspect(new Secret(PLAINTEXT))).not.toContain(PLAINTEXT);
  });

  it("exposes the value only through expose()", () => {
    expect(new Secret(PLAINTEXT).expose()).toBe(PLAINTEXT);
  });

  it("isSecret narrows", () => {
    expect(isSecret(new Secret("x"))).toBe(true);
    expect(isSecret("x")).toBe(false);
    expect(isSecret(undefined)).toBe(false);
  });
});

describe("snapshot serialization", () => {
  const snapshot = createSnapshot({
    key: { projectId: "storefront", environment: "production", namespace: "meta-capi" },
    version: 4n,
    values: {
      pixel_id: "1234567890",
      access_token: new Secret(PLAINTEXT),
    },
    resolvedAt: 1_700_000_000_000,
  });

  it("never emits the plaintext through JSON.stringify", () => {
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(PLAINTEXT);
    expect(json).toContain("[redacted]");
  });

  it("keeps non-secret values readable", () => {
    const json = JSON.stringify(snapshot);
    expect(json).toContain("1234567890");
  });

  it("serializes bigint version as a string rather than throwing", () => {
    // JSON.stringify throws on a bare bigint; toJSON must have handled it.
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(JSON.stringify(snapshot)).toContain('"version":"4"');
  });

  it("still exposes the secret to code that asks for it", () => {
    const token = snapshot.values["access_token"];
    expect(isSecret(token)).toBe(true);
    expect((token as Secret<string>).expose()).toBe(PLAINTEXT);
  });

  it("freezes values so a consumer cannot mutate shared cache state", () => {
    expect(Object.isFrozen(snapshot.values)).toBe(true);
  });
});
