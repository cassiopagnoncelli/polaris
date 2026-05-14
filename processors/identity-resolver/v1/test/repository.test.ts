/**
 * Behavioral tests for `InMemoryIdentityLinkRepository` (P8-002b).
 *
 * The in-memory adapter is the canonical reference implementation: the
 * Kysely-backed adapter in production should produce identical behavior.
 * These tests pin the contract.
 *
 * @see docs/implementation/tasks/P8-002b-identity-resolver-behavioral-tests.md
 */

import { describe, expect, it } from "vitest";

import { InMemoryIdentityLinkRepository, type InsertLinkInput } from "../src/repository.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";

function fixedNow(iso = "2026-05-12T12:00:00.000Z"): () => Date {
  return () => new Date(iso);
}

function makeInsertInput(overrides: Partial<InsertLinkInput> = {}): InsertLinkInput {
  return {
    project_id: "storefront",
    environment: "production",
    left_identifier: "anonymous_id:anon-1",
    right_identifier: "customer_id:cus_1",
    confidence: "authoritative",
    evidence_type: "explicit_overlap",
    evidence: {},
    reason: "test fixture",
    processor_name: PROCESSOR_NAME,
    processor_version: PROCESSOR_VERSION,
    ...overrides,
  };
}

describe("InMemoryIdentityLinkRepository.findActive", () => {
  it("returns an empty array for unseen identifiers", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const rows = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:nope",
    });
    expect(rows).toEqual([]);
  });

  it("returns the row regardless of which slot (left/right) the identifier sits in", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    await repo.insertLink(makeInsertInput());

    const byLeft = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
    });
    const byRight = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "customer_id:cus_1",
    });
    expect(byLeft).toHaveLength(1);
    expect(byRight).toHaveLength(1);
    expect(byLeft[0]?.link_id).toBe(byRight[0]?.link_id);
  });

  it("scopes lookups by (project_id, environment) — does not leak across projects", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    await repo.insertLink(makeInsertInput({ project_id: "storefront" }));
    await repo.insertLink(makeInsertInput({ project_id: "marketing" }));

    const storefront = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
    });
    expect(storefront).toHaveLength(1);
    expect(storefront[0]?.project_id).toBe("storefront");
  });

  it("filters by evidence_type when supplied", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    await repo.insertLink(makeInsertInput({ evidence_type: "explicit_overlap" }));
    await repo.insertLink(
      makeInsertInput({
        left_identifier: "anonymous_id:anon-1",
        right_identifier: "customer_id:cus_2",
        evidence_type: "probabilistic_overlap",
      }),
    );
    const explicit = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
      evidence_type: "explicit_overlap",
    });
    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.evidence_type).toBe("explicit_overlap");
  });

  it("excludes superseded rows from active lookups", async () => {
    const repo = new InMemoryIdentityLinkRepository({ now: fixedNow() });
    const inserted = await repo.insertLink(makeInsertInput());
    await repo.supersedeLink({ link_id: inserted.link_id });

    const after = await repo.findActive({
      project_id: "storefront",
      environment: "production",
      identifier: "anonymous_id:anon-1",
    });
    expect(after).toEqual([]);
  });
});

describe("InMemoryIdentityLinkRepository.insertLink", () => {
  it("returns the persisted row with a generated link_id when none is supplied", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const row = await repo.insertLink(makeInsertInput());
    expect(typeof row.link_id).toBe("string");
    expect(row.link_id.length).toBeGreaterThan(0);
    expect(row.superseded_at).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it("uses the supplied link_id when present", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const row = await repo.insertLink(makeInsertInput({ link_id: "lnk_explicit_1" }));
    expect(row.link_id).toBe("lnk_explicit_1");
  });

  it("stamps run_id and evidence as supplied", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const row = await repo.insertLink(
      makeInsertInput({
        run_id: "run_test_42",
        evidence: { source_event_id: "evt_1" },
      }),
    );
    expect(row.run_id).toBe("run_test_42");
    expect(row.evidence).toEqual({ source_event_id: "evt_1" });
  });
});

describe("InMemoryIdentityLinkRepository.supersedeLink", () => {
  it("sets superseded_at on the marked row and preserves the audit trail (no delete)", async () => {
    const repo = new InMemoryIdentityLinkRepository({ now: fixedNow() });
    const row = await repo.insertLink(makeInsertInput());
    const superseded = await repo.supersedeLink({ link_id: row.link_id });

    expect(superseded.link_id).toBe(row.link_id);
    expect(superseded.superseded_at).toBeInstanceOf(Date);
    // The row is still findable by link_id (audit trail preserved).
    const found = await repo.findById(row.link_id);
    expect(found?.superseded_at).toEqual(superseded.superseded_at);
  });

  it("uses the supplied superseded_at when present", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const row = await repo.insertLink(makeInsertInput());
    const at = new Date("2026-06-01T00:00:00.000Z");
    const superseded = await repo.supersedeLink({ link_id: row.link_id, superseded_at: at });
    expect(superseded.superseded_at).toEqual(at);
  });
});

describe("InMemoryIdentityLinkRepository.findById", () => {
  it("returns null for unseen link ids", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    expect(await repo.findById("lnk_nope")).toBeNull();
  });

  it("returns the row (active or superseded)", async () => {
    const repo = new InMemoryIdentityLinkRepository();
    const row = await repo.insertLink(makeInsertInput());
    const found = await repo.findById(row.link_id);
    expect(found?.link_id).toBe(row.link_id);
  });
});
