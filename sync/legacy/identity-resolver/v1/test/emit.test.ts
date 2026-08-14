/**
 * Tests for `buildIdentityEventEnvelope` — the pure envelope builder
 * that turns an `IdentityEventEmission` into the canonical wire shape
 * the runtime publishes onto `identity.events` (P8-002b).
 *
 * The builder produces:
 *   - a closed `event` field per the IdentityEventName union
 *   - the dual-shape processor stamp (nested `processor: {...}` +
 *     flat `processor_name` / `processor_version` columns) so ClickHouse
 *     Kafka Engine reads both forms
 *   - per-event-name properties payload (linked / merged / rotated)
 *   - frozen `source: { type: 'internal', id: 'identity-resolver' }` and
 *     an empty canonical context (resolver-internal events carry no
 *     browser context)
 *
 * @see docs/implementation/tasks/P8-002b-identity-resolver-behavioral-tests.md
 */

import { describe, expect, it } from "vitest";

import { buildIdentityEventEnvelope, type IdentityEventEmission } from "../src/emit.js";
import type { IdentityLinkRecord } from "../src/repository.js";
import { PROCESSOR_NAME, PROCESSOR_VERSION } from "../src/transform.js";
import type { RawEventEnvelope } from "../src/types.js";

const RAW: RawEventEnvelope = {
  event_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
  event: "user.signed_in",
  schema_version: 1,
  project_id: "storefront",
  environment: "production",
  occurred_at: "2026-05-12T12:00:00.000Z",
  ingested_at: "2026-05-12T12:00:00.250Z",
  source: { type: "web", id: "storefront-web" },
  identity: {
    customer_id: "cus_1",
    anonymous_id: "anon-1",
    session_id: null,
    device_id: null,
  },
  context: {},
  properties: {},
};

const ACTIVE_LINK: IdentityLinkRecord = {
  link_id: "lnk_active_1",
  project_id: "storefront",
  environment: "production",
  left_identifier: "anonymous_id:anon-1",
  right_identifier: "customer_id:cus_1",
  confidence: "authoritative",
  evidence_type: "explicit_overlap",
  evidence: { source_event_id: RAW.event_id },
  reason: "first observation of (cus_1, anon-1)",
  processor_name: PROCESSOR_NAME,
  processor_version: PROCESSOR_VERSION,
  run_id: "run_test_1",
  created_at: new Date("2026-05-12T12:00:00.500Z"),
  superseded_at: null,
};

const SUPERSEDED_LINK: IdentityLinkRecord = {
  link_id: "lnk_old_1",
  project_id: "storefront",
  environment: "production",
  left_identifier: "anonymous_id:anon-1",
  right_identifier: "customer_id:cus_old",
  confidence: "authoritative",
  evidence_type: "explicit_overlap",
  evidence: {},
  reason: "earlier observation",
  processor_name: PROCESSOR_NAME,
  processor_version: PROCESSOR_VERSION,
  run_id: "run_test_0",
  created_at: new Date("2026-05-01T00:00:00.000Z"),
  superseded_at: new Date("2026-05-12T12:00:00.500Z"),
};

const NOW = () => new Date("2026-05-12T12:00:00.600Z");

/**
 * The run doing the emitting. Distinct from `ACTIVE_LINK.run_id` on purpose:
 * on the idempotent path the link was created by an earlier run, and the
 * event still belongs to the run that emitted it.
 */
const EMITTING_RUN = "019ff118-7484-709a-9179-77994d4702bf";

describe("buildIdentityEventEnvelope — common shape", () => {
  it("stamps the processor identity on both nested + flat shapes", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000001",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.processor_name).toBe(PROCESSOR_NAME);
    expect(env.processor_version).toBe(PROCESSOR_VERSION);
    expect(env.processor.name).toBe(PROCESSOR_NAME);
    expect(env.processor.version).toBe(PROCESSOR_VERSION);
    expect(env.processor.ran_at).toBe("2026-05-12T12:00:00.600Z");
  });

  it("preserves project_id / environment / occurred_at from the raw envelope", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000002",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.project_id).toBe(RAW.project_id);
    expect(env.environment).toBe(RAW.environment);
    expect(env.occurred_at).toBe(RAW.occurred_at);
    expect(env.identity).toEqual(RAW.identity);
  });

  it("uses internal source marker (type=internal, id=identity-resolver) and an empty context", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000003",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.source.type).toBe("internal");
    expect(env.source.id).toBe("identity-resolver");
    expect(env.context.ip).toBeNull();
    expect(env.context.user_agent).toBeNull();
  });

  it("stamps the explicit event_id parameter (the runtime supplies a fresh UUIDv7)", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000004",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.event_id).toBe("018f1b9e-7b50-7b12-aaaa-000000000004");
  });
});

describe("buildIdentityEventEnvelope — identity.linked properties", () => {
  it("emits link_id + confidence + identifiers + evidence verbatim from the link row", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000005",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.event).toBe("identity.linked");
    const props = env.properties as Record<string, unknown>;
    expect(props["link_id"]).toBe(ACTIVE_LINK.link_id);
    expect(props["confidence"]).toBe(ACTIVE_LINK.confidence);
    expect(props["left_identifier"]).toBe(ACTIVE_LINK.left_identifier);
    expect(props["right_identifier"]).toBe(ACTIVE_LINK.right_identifier);
    expect(props["evidence_type"]).toBe(ACTIVE_LINK.evidence_type);
    // The emitting run, not `ACTIVE_LINK.run_id` (the run that first created
    // the link). Before runs were registered this field carried
    // `synthetic:<link_id>`, which joined to nothing.
    expect(props["run_id"]).toBe(EMITTING_RUN);
    expect(env.processor.run_id).toBe(EMITTING_RUN);
  });
});

describe("buildIdentityEventEnvelope — identity.merged properties", () => {
  it("emits link_id + the new / shared / superseded identifiers + the old link_id", () => {
    // ACTIVE_LINK: (anonymous_id:anon-1, customer_id:cus_1)
    // SUPERSEDED:  (anonymous_id:anon-1, customer_id:cus_old)
    // Shared: anonymous_id:anon-1
    // New: customer_id:cus_1
    // Superseded counterpart: customer_id:cus_old
    const emission: IdentityEventEmission = {
      event_name: "identity.merged",
      link: ACTIVE_LINK,
      superseded: SUPERSEDED_LINK,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000006",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.event).toBe("identity.merged");
    const props = env.properties as Record<string, unknown>;
    expect(props["link_id"]).toBe(ACTIVE_LINK.link_id);
    expect(props["shared_identifier"]).toBe("anonymous_id:anon-1");
    expect(props["new_identifier"]).toBe("customer_id:cus_1");
    expect(props["superseded_identifier"]).toBe("customer_id:cus_old");
    expect(props["superseded_link_id"]).toBe(SUPERSEDED_LINK.link_id);
  });
});

describe("buildIdentityEventEnvelope — identity.rotated properties", () => {
  it("emits stable + new + previous identifiers for an anon rotation under a stable customer_id", () => {
    // For a rotation: stable side persists (e.g. customer_id), the
    // anonymous_id changes. We re-purpose the fixtures here: SUPERSEDED_LINK
    // shares customer_id:cus_1 with a NEW link that swapped the anon_id.
    const STABLE_CUSTOMER: IdentityLinkRecord = {
      ...ACTIVE_LINK,
      left_identifier: "anonymous_id:anon-NEW",
      right_identifier: "customer_id:cus_1",
    };
    const PRIOR_STABLE: IdentityLinkRecord = {
      ...SUPERSEDED_LINK,
      left_identifier: "anonymous_id:anon-OLD",
      right_identifier: "customer_id:cus_1",
    };
    const emission: IdentityEventEmission = {
      event_name: "identity.rotated",
      link: STABLE_CUSTOMER,
      superseded: PRIOR_STABLE,
      idempotent: false,
    };
    const env = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000007",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(env.event).toBe("identity.rotated");
    const props = env.properties as Record<string, unknown>;
    expect(props["stable_identifier"]).toBe("customer_id:cus_1");
    expect(props["new_identifier"]).toBe("anonymous_id:anon-NEW");
    expect(props["previous_identifier"]).toBe("anonymous_id:anon-OLD");
  });
});

describe("buildIdentityEventEnvelope — determinism", () => {
  it("produces a deterministic envelope across two calls with the same inputs", () => {
    const emission: IdentityEventEmission = {
      event_name: "identity.linked",
      link: ACTIVE_LINK,
      idempotent: false,
    };
    const e1 = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000008",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    const e2 = buildIdentityEventEnvelope({
      raw: RAW,
      emission,
      eventId: "018f1b9e-7b50-7b12-aaaa-000000000008",
      now: NOW,
      run_id: EMITTING_RUN,
    });
    expect(JSON.stringify(e1)).toBe(JSON.stringify(e2));
  });
});
