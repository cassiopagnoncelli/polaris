import { describe, expect, it } from "vitest";

import { normalizeAddress } from "../src/address.js";

/**
 * The location half of the match set, one rule per field.
 *
 * `country` carries the weight here. Every other rule in this package
 * degrades to a missing match key when it cannot normalize a value; this
 * one degrades to a WRONG one if it guesses, because a two-letter string
 * that is not a country code is one letter away from being another
 * country's. So the refusals are the tests that matter most.
 */
describe("normalizeAddress: city and state", () => {
  it("lowercases and strips punctuation and spaces", () => {
    expect(normalizeAddress({ city: "Menlo Park" }).city).toBe("menlopark");
    expect(normalizeAddress({ city: "St. Louis" }).city).toBe("stlouis");
    expect(normalizeAddress({ state: "CA" }).state).toBe("ca");
  });

  it("keeps a spelled-out US state spelled out", () => {
    // Meta prefers the two-letter ANSI abbreviation. Mapping to it is a
    // fifty-row table that stops being unambiguous the moment another
    // country's states arrive, so the platform publishes one rule for
    // every country and a vendor's own `normalize/` may narrow it.
    expect(normalizeAddress({ state: "California" }).state).toBe("california");
  });

  it("keeps accents, as the name rule does", () => {
    expect(normalizeAddress({ city: "São Paulo" }).city).toBe("sãopaulo");
  });

  it("refuses a value with nothing left after stripping", () => {
    expect(normalizeAddress({ city: "  " }).city).toBeNull();
    expect(normalizeAddress({ state: "--" }).state).toBeNull();
  });
});

describe("normalizeAddress: postal code", () => {
  it("lowercases and removes whitespace", () => {
    expect(normalizeAddress({ postal_code: "SW1A 1AA", country: "GB" }).postal_code).toBe(
      "sw1a1aa",
    );
    expect(normalizeAddress({ postal_code: " 01310-100 ", country: "BR" }).postal_code).toBe(
      "01310-100",
    );
  });

  it("truncates to five characters in the US", () => {
    expect(normalizeAddress({ postal_code: "94025-1234", country: "US" }).postal_code).toBe(
      "94025",
    );
    expect(normalizeAddress({ postal_code: "94025", country: "US" }).postal_code).toBe("94025");
  });

  it("keeps the whole code when the country is not the US", () => {
    // Truncating `sw1a1aa` to `sw1a1` hashes something that is not a
    // postcode at all.
    expect(normalizeAddress({ postal_code: "SW1A1AA", country: "GB" }).postal_code).toBe("sw1a1aa");
  });

  it("keeps the whole code when no country is on the address", () => {
    // A whole ZIP+4 costs a match against a vendor holding five digits; a
    // truncated foreign code corrupts one that would have matched.
    expect(normalizeAddress({ postal_code: "94025-1234" }).postal_code).toBe("94025-1234");
  });

  it("refuses an empty code", () => {
    expect(normalizeAddress({ postal_code: "   " }).postal_code).toBeNull();
  });
});

describe("normalizeAddress: country", () => {
  it("accepts an assigned alpha-2 code in any case", () => {
    expect(normalizeAddress({ country: "US" }).country).toBe("us");
    expect(normalizeAddress({ country: "br" }).country).toBe("br");
    expect(normalizeAddress({ country: "Lu" }).country).toBe("lu");
  });

  it("maps the names and abbreviations producers actually send", () => {
    expect(normalizeAddress({ country: "Brazil" }).country).toBe("br");
    expect(normalizeAddress({ country: "Brasil" }).country).toBe("br");
    expect(normalizeAddress({ country: "bra" }).country).toBe("br");
    expect(normalizeAddress({ country: "United States of America" }).country).toBe("us");
    expect(normalizeAddress({ country: "U.S.A." }).country).toBe("us");
    expect(normalizeAddress({ country: "United Kingdom" }).country).toBe("gb");
    expect(normalizeAddress({ country: "UK" }).country).toBe("gb");
    expect(normalizeAddress({ country: "Deutschland" }).country).toBe("de");
    expect(normalizeAddress({ country: "México" }).country).toBe("mx");
  });

  it("refuses an unknown country rather than emitting a wrong code", () => {
    // The whole reason this rule refuses: `"Zz"` is a two-letter string,
    // and shipping it as a country code puts a person in an audience that
    // is not theirs.
    expect(normalizeAddress({ country: "Zz" }).country).toBeNull();
    expect(normalizeAddress({ country: "Narnia" }).country).toBeNull();
    expect(normalizeAddress({ country: "Korea" }).country).toBeNull();
    expect(normalizeAddress({ country: "123" }).country).toBeNull();
    expect(normalizeAddress({ country: " " }).country).toBeNull();
  });

  it("resolves the country before the postal code that depends on it", () => {
    expect(
      normalizeAddress({ postal_code: "94025-1234", country: "United States" }).postal_code,
    ).toBe("94025");
  });
});

describe("normalizeAddress: absent input", () => {
  it("reports every slot null for an empty bag", () => {
    expect(normalizeAddress({})).toEqual({
      city: null,
      state: null,
      postal_code: null,
      country: null,
    });
  });
});
