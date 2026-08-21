import { describe, expect, it } from "vitest";
import { checkoutStartedV1PropertiesSchema } from "../src/events/checkout/started.v1.js";
import { identityLinkRejectedV1PropertiesSchema } from "../src/events/identity/link_rejected.v1.js";
import { identityLinkedV2PropertiesSchema } from "../src/events/identity/linked.v2.js";
import { identityMergeSuspendedV1PropertiesSchema } from "../src/events/identity/merge_suspended.v1.js";
import { identityMergedV2PropertiesSchema } from "../src/events/identity/merged.v2.js";
import { pageViewedV1PropertiesSchema } from "../src/events/page/viewed.v1.js";
import { pageViewedV2PropertiesSchema } from "../src/events/page/viewed.v2.js";
import { paymentApprovedV1PropertiesSchema } from "../src/events/payment/approved.v1.js";
import { profileUpdatedV1PropertiesSchema } from "../src/events/profile/updated.v1.js";
import { signupCompletedV1PropertiesSchema } from "../src/events/signup/completed.v1.js";
import { subscriptionRenewedV1PropertiesSchema } from "../src/events/subscription/renewed.v1.js";
import { userIdentifiedV1PropertiesSchema } from "../src/events/user/identified.v1.js";
import { checkoutStartedV1Fixture, pageViewedV1Fixture, pageViewedV2Fixture } from "./fixtures.js";

describe("page.viewed v1 (deprecated)", () => {
  it("accepts the v1 fixture properties", () => {
    const result = pageViewedV1PropertiesSchema.safeParse(pageViewedV1Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects v2-style properties (referrer is unknown in v1)", () => {
    // v2 adds new fields, so the v1 schema must NOT silently accept v2.
    // Strict mode is what gives us this signal.
    const result = pageViewedV1PropertiesSchema.safeParse(pageViewedV2Fixture.properties);
    expect(result.success).toBe(false);
  });
});

describe("page.viewed v2 (active)", () => {
  it("accepts the v2 fixture properties", () => {
    const result = pageViewedV2PropertiesSchema.safeParse(pageViewedV2Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects v1-style properties (host was removed)", () => {
    const result = pageViewedV2PropertiesSchema.safeParse(pageViewedV1Fixture.properties);
    expect(result.success).toBe(false);
  });

  it("accepts null search and null referrer", () => {
    const result = pageViewedV2PropertiesSchema.safeParse({
      path: "/",
      search: null,
      title: "Home",
      referrer: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    // referrer is required (nullable, not optional); a missing key is a
    // contract violation we want to catch.
    const result = pageViewedV2PropertiesSchema.safeParse({
      path: "/",
      search: null,
      title: "Home",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// `name` and `category`, added in place on 2026-08-21 so Segment's
// `page(category, name)` has somewhere to land. The whole point of an
// in-place addition is that it takes nothing away, so the guarantee is
// stated as a test rather than left to the changelog.
// ---------------------------------------------------------------------

describe("page.viewed v2 — name and category (in-place addition)", () => {
  /** The v2 body exactly as it was before the addition, frozen literally. */
  const FOUR_KEY_BODY = {
    path: "/products/sku-1",
    search: "?ref=email",
    title: "Product SKU-1",
    referrer: "https://example.com/",
  };

  it("still accepts the four-key body that predates the addition", () => {
    // The in-place guarantee: every previously-valid v2 event stays valid.
    expect(pageViewedV2PropertiesSchema.safeParse(FOUR_KEY_BODY).success).toBe(true);
  });

  it("accepts name", () => {
    const result = pageViewedV2PropertiesSchema.safeParse({
      ...FOUR_KEY_BODY,
      name: "Product Detail",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Product Detail");
  });

  it("accepts category", () => {
    const result = pageViewedV2PropertiesSchema.safeParse({
      ...FOUR_KEY_BODY,
      category: "Catalog",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.category).toBe("Catalog");
  });

  it("accepts null name and null category", () => {
    // Nullable as well as optional: a producer that always sends the key
    // and sometimes has no value does not have to omit it conditionally.
    const result = pageViewedV2PropertiesSchema.safeParse({
      ...FOUR_KEY_BODY,
      name: null,
      category: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty name and an over-long category", () => {
    expect(pageViewedV2PropertiesSchema.safeParse({ ...FOUR_KEY_BODY, name: "" }).success).toBe(
      false,
    );
    expect(
      pageViewedV2PropertiesSchema.safeParse({ ...FOUR_KEY_BODY, category: "c".repeat(129) })
        .success,
    ).toBe(false);
  });

  it("keeps previously-invalid bodies invalid", () => {
    // The other half of the in-place rule. Two ways a v2 body was already
    // wrong, neither of which the addition may have rescued: an unknown
    // key (the schema is still strict) and a missing required one.
    expect(
      pageViewedV2PropertiesSchema.safeParse({ ...FOUR_KEY_BODY, host: "example.com" }).success,
    ).toBe(false);
    const { referrer: _dropped, ...missingReferrer } = FOUR_KEY_BODY;
    expect(pageViewedV2PropertiesSchema.safeParse(missingReferrer).success).toBe(false);
  });
});

describe("checkout.started v1 (active)", () => {
  it("accepts the v1 fixture properties", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse(checkoutStartedV1Fixture.properties);
    expect(result.success).toBe(true);
  });

  it("rejects empty cart items", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      items: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO currency code", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      currency: "brl",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative unit_price (minor units must be non-negative)", () => {
    const result = checkoutStartedV1PropertiesSchema.safeParse({
      ...checkoutStartedV1Fixture.properties,
      items: [{ sku: "X", name: "Y", quantity: 1, unit_price: -1 }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------
// The four events every vendor consumer maps but the catalog did not
// register. Until this card they were rejected at ingest as
// `unknown_event`, which made most of the destination surface unreachable
// code — the mappers, their golden fixtures and their SPEC.md tables were
// all written against events the platform refused.
//
// These schemas were written to accept exactly what those existing
// fixtures carry, so registration turns the mappers live without editing a
// single mapper. The assertions below use the fixture property shapes
// verbatim for that reason.
// ---------------------------------------------------------------------

describe("payment.approved v1", () => {
  const fixture = {
    order_id: "ord_1024",
    amount_minor: 24990,
    currency: "BRL",
    transaction_id: "txn_88",
    cart_id: "cart_7",
  };

  it("accepts the shape the vendor purchase mappers already read", () => {
    expect(paymentApprovedV1PropertiesSchema.safeParse(fixture).success).toBe(true);
  });

  it("accepts the minimal shape (optionals absent)", () => {
    const result = paymentApprovedV1PropertiesSchema.safeParse({
      order_id: "ord_1",
      amount_minor: 0,
      currency: "USD",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a major-units amount expressed as a float", () => {
    // Money is minor-units integers end to end; a float here is the classic
    // way currency exponents get silently wrong downstream.
    const result = paymentApprovedV1PropertiesSchema.safeParse({
      ...fixture,
      amount_minor: 249.9,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO-4217 currency", () => {
    const result = paymentApprovedV1PropertiesSchema.safeParse({ ...fixture, currency: "brl" });
    expect(result.success).toBe(false);
  });
});

describe("user.identified v1", () => {
  it("accepts arbitrary project traits alongside the known slots", () => {
    // Passthrough is deliberate and is the whole point: traits are project
    // semantics. A strict schema would reject every project that declared a
    // trait of its own.
    const result = userIdentifiedV1PropertiesSchema.safeParse({
      email: "ada@example.com",
      phone: "+5511999999999",
      plan: "pro",
      ltv_band: "high",
      nps_bucket: 9,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["plan"]).toBe("pro");
      expect(result.data["nps_bucket"]).toBe(9);
    }
  });

  it("accepts an empty trait bag", () => {
    expect(userIdentifiedV1PropertiesSchema.safeParse({}).success).toBe(true);
  });

  it("still validates the slots the platform consumes", () => {
    // email/phone feed destination identity hashing, so their shapes are
    // pinned even though passthrough accepts unknown keys.
    expect(userIdentifiedV1PropertiesSchema.safeParse({ email: "not-an-email" }).success).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------
// The trait slots pinned in place on 2026-08-21. These are the names the
// ad platforms and Braze match on; before this the normalizer received
// them as unnamed passthrough keys and could not hash what it could not
// name. Pinning names a shape — it does not close the set, which is what
// the passthrough assertions below exist to hold.
// ---------------------------------------------------------------------

describe("user.identified v1 — pinned trait slots (in-place addition)", () => {
  /** One well-formed value per pinned slot. Drives a test per slot. */
  const PINNED: Array<[string, unknown]> = [
    ["name", "Ada Lovelace"],
    ["gender", "non-binary"],
    ["birthday", "1990-02-14"],
    ["avatar", "https://cdn.example.com/avatars/ada.png"],
    ["title", "Principal Engineer"],
    ["username", "ada"],
    ["website", "https://ada.example.com"],
    ["created_at", "2026-01-04T09:30:00.000Z"],
    [
      "address",
      {
        street: "Rua da Consolação 1000",
        city: "São Paulo",
        state: "SP",
        postal_code: "01302-000",
        country: "BR",
      },
    ],
    [
      "company",
      {
        id: "co_42",
        name: "Analytical Engines",
        industry: "software",
        employee_count: 240,
        plan: "enterprise",
      },
    ],
  ];

  it.each(PINNED)("accepts %s", (slot, value) => {
    const result = userIdentifiedV1PropertiesSchema.safeParse({ [slot]: value });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data[slot]).toEqual(value);
  });

  it.each(PINNED)("accepts a null %s", (slot) => {
    // Every slot is optional AND nullable: a producer that clears a trait
    // sends null rather than dropping the key, and both must validate.
    expect(userIdentifiedV1PropertiesSchema.safeParse({ [slot]: null }).success).toBe(true);
  });

  it("still accepts the five-key body that predates the addition", () => {
    // The in-place guarantee, frozen literally: this is what the entry
    // pinned before today, and it must keep validating unchanged.
    const result = userIdentifiedV1PropertiesSchema.safeParse({
      email: "ada@example.com",
      phone: "+5511999999999",
      first_name: "Ada",
      last_name: "Lovelace",
      locale: "pt-BR",
    });
    expect(result.success).toBe(true);
  });

  it("still passes unknown project traits through, nested ones included", () => {
    // Naming ten slots must not have turned the bag into a whitelist.
    const result = userIdentifiedV1PropertiesSchema.safeParse({
      name: "Ada Lovelace",
      ltv_band: "high",
      address: { city: "São Paulo", complement: "apto 41" },
      company: { name: "Analytical Engines", crm_id: "sf_991" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["ltv_band"]).toBe("high");
      // Nested objects are passthrough for the same reason the parent is:
      // an address the platform does not model is still the project's.
      expect(result.data.address).toEqual({ city: "São Paulo", complement: "apto 41" });
      expect(result.data.company).toEqual({ name: "Analytical Engines", crm_id: "sf_991" });
    }
  });

  it("rejects a birthday that never happened", () => {
    // Shape alone is not enough. Meta's `db` is YYYYMMDD, so a date that
    // does not exist becomes a match key the vendor silently drops —
    // which is the expensive place to find out.
    expect(userIdentifiedV1PropertiesSchema.safeParse({ birthday: "1990-02-30" }).success).toBe(
      false,
    );
    expect(userIdentifiedV1PropertiesSchema.safeParse({ birthday: "2023-02-29" }).success).toBe(
      false,
    );
    expect(userIdentifiedV1PropertiesSchema.safeParse({ birthday: "20/03/1990" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed website and avatar", () => {
    expect(userIdentifiedV1PropertiesSchema.safeParse({ website: "example.com" }).success).toBe(
      false,
    );
    expect(userIdentifiedV1PropertiesSchema.safeParse({ avatar: "not-a-url" }).success).toBe(false);
  });

  it("rejects a created_at that is a date rather than a timestamp", () => {
    expect(userIdentifiedV1PropertiesSchema.safeParse({ created_at: "2026-01-04" }).success).toBe(
      false,
    );
  });

  it("accepts a created_at carrying an offset", () => {
    // Deliberately looser than the platform-stamped envelope timestamps:
    // this value is mirrored from whichever system owned the account
    // before Polaris, and Segment's `createdAt` routinely carries one.
    expect(
      userIdentifiedV1PropertiesSchema.safeParse({ created_at: "2026-01-04T09:30:00+02:00" })
        .success,
    ).toBe(true);
  });

  it("rejects a non-numeric employee_count and an over-long gender", () => {
    expect(
      userIdentifiedV1PropertiesSchema.safeParse({ company: { employee_count: "240" } }).success,
    ).toBe(false);
    expect(
      userIdentifiedV1PropertiesSchema.safeParse({ company: { employee_count: 12.5 } }).success,
    ).toBe(false);
    expect(userIdentifiedV1PropertiesSchema.safeParse({ gender: "g".repeat(33) }).success).toBe(
      false,
    );
  });
});

describe("signup.completed v1", () => {
  it("accepts the fixture shape with predicted LTV", () => {
    const result = signupCompletedV1PropertiesSchema.safeParse({
      registration_method: "google",
      currency: "USD",
      predicted_ltv_minor: 15000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a bare registration with no monetary prediction", () => {
    const result = signupCompletedV1PropertiesSchema.safeParse({
      registration_method: "password",
    });
    expect(result.success).toBe(true);
  });
});

describe("subscription.renewed v1", () => {
  it("accepts the fixture shape", () => {
    const result = subscriptionRenewedV1PropertiesSchema.safeParse({
      subscription_id: "sub_9",
      amount_minor: 4990,
      currency: "EUR",
      predicted_ltv_minor: 59880,
    });
    expect(result.success).toBe(true);
  });

  it("keeps subscription lineage required", () => {
    // Without subscription_id a renewal is indistinguishable from a one-off
    // payment downstream, which is exactly why this event is separate from
    // payment.approved.
    const result = subscriptionRenewedV1PropertiesSchema.safeParse({
      amount_minor: 4990,
      currency: "EUR",
    });
    expect(result.success).toBe(false);
  });
});

describe("identity v2 and profile events", () => {
  const PROFILE_A = "019ffe00-0000-7000-8000-00000000000a";
  const PROFILE_B = "019ffe00-0000-7000-8000-00000000000b";
  const EVENT_ID = "019ffe00-0000-7000-8000-0000000000ee";

  it("identity.linked v2 names the person, which v1 could not", () => {
    const result = identityLinkedV2PropertiesSchema.safeParse({
      profile_id: PROFILE_A,
      identifier: "customer_id:cus_42",
      profile_created: true,
      link_id: "019ffe00-0000-7000-8000-0000000000d1",
      evidence_type: "explicit_overlap",
      source_event_id: EVENT_ID,
      run_id: "run_1",
    });
    expect(result.success).toBe(true);
  });

  it("identity.merged v2 carries both sides so reads can resolve either", () => {
    const result = identityMergedV2PropertiesSchema.safeParse({
      winner_profile_id: PROFILE_A,
      loser_profile_id: PROFILE_B,
      merge_id: "019ffe00-0000-7000-8000-0000000000c1",
      identifiers_moved: 3,
      source_event_id: EVENT_ID,
      reason: "login linked two previously separate profiles",
      run_id: "run_1",
    });
    expect(result.success).toBe(true);
  });

  it("identity.link_rejected distinguishes the two safeguard causes", () => {
    for (const reason of ["identifier_cap", "denylisted"] as const) {
      const result = identityLinkRejectedV1PropertiesSchema.safeParse({
        profile_id: PROFILE_A,
        identifier: "anonymous_id:kiosk_1",
        reason,
        source_event_id: EVENT_ID,
        run_id: "run_1",
      });
      expect(result.success).toBe(true);
    }
    const bogus = identityLinkRejectedV1PropertiesSchema.safeParse({
      profile_id: PROFILE_A,
      identifier: "anonymous_id:x",
      reason: "because_i_said_so",
      source_event_id: EVENT_ID,
      run_id: "run_1",
    });
    expect(bogus.success).toBe(false);
  });

  it("identity.merge_suspended records the breaker's numbers", () => {
    const result = identityMergeSuspendedV1PropertiesSchema.safeParse({
      profile_id: PROFILE_A,
      merge_count: 812,
      merge_limit: 50,
      window_seconds: 3600,
      source_event_id: EVENT_ID,
      run_id: "run_1",
    });
    expect(result.success).toBe(true);
  });

  it("profile.updated names its writer and carries changed keys only", () => {
    const result = profileUpdatedV1PropertiesSchema.safeParse({
      profile_id: PROFILE_A,
      traits_version: 12,
      writer: "computed_traits",
      traits: { ltv_minor: 128000 },
      run_id: "run_1",
    });
    expect(result.success).toBe(true);
  });

  it("profile.updated rejects an unsanctioned writer", () => {
    // Only three writers may touch traits; the enum is the contract.
    const result = profileUpdatedV1PropertiesSchema.safeParse({
      profile_id: PROFILE_A,
      traits_version: 1,
      writer: "some_random_consumer",
      traits: {},
      run_id: "run_1",
    });
    expect(result.success).toBe(false);
  });
});
