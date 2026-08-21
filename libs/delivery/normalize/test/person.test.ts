import { describe, expect, it } from "vitest";

import { normalizePerson } from "../src/person.js";

/**
 * One rule per field, checked against the canonical forms Meta publishes
 * for the `user_data` customer-information parameters — the same forms
 * TikTok, Reddit and Snap ask for where they overlap.
 *
 * The refusals matter as much as the conversions. Every one of these
 * values is hashed before it leaves the platform, so a rule that guesses
 * does not produce a slightly-wrong string: it produces a digest that
 * matches a different person, or nobody, with nothing downstream able to
 * tell which.
 */
describe("normalizePerson: names", () => {
  it("lowercases and strips punctuation and spaces", () => {
    expect(normalizePerson({ first_name: "John" }).first_name).toBe("john");
    expect(normalizePerson({ last_name: "Smith" }).last_name).toBe("smith");
    expect(normalizePerson({ last_name: "O'Brien-Smith" }).last_name).toBe("obriensmith");
    expect(normalizePerson({ first_name: "  Mary Jane " }).first_name).toBe("maryjane");
  });

  it("keeps accents rather than folding them to ASCII", () => {
    // Meta asks for "special characters in UTF-8 format". A vendor holding
    // `josé` matches `josé`; folding to `jose` would hash a different name.
    expect(normalizePerson({ first_name: "José" }).first_name).toBe("josé");
  });

  it("composes to NFC so the same name entered on two systems hashes alike", () => {
    // `é` as one code point and as `e` + U+0301 render identically and
    // compare unequal. Without NFC the digest is a property of the
    // keyboard rather than of the name.
    const composed = normalizePerson({ first_name: "Jos\u00e9" }).first_name;
    const decomposed = normalizePerson({ first_name: "Jose\u0301" }).first_name;
    expect(composed).toBe("jos\u00e9");
    expect(decomposed).toBe(composed);
  });

  it("refuses a name with nothing left after stripping", () => {
    expect(normalizePerson({ first_name: "---" }).first_name).toBeNull();
    expect(normalizePerson({ first_name: "   " }).first_name).toBeNull();
  });
});

describe("normalizePerson: gender", () => {
  it("maps the spellings producers send onto the vendors' two tokens", () => {
    for (const value of ["m", "M", "male", "Male", "MAN"]) {
      expect(normalizePerson({ gender: value }).gender).toBe("m");
    }
    for (const value of ["f", "F", "female", "Female", "woman"]) {
      expect(normalizePerson({ gender: value }).gender).toBe("f");
    }
  });

  it("refuses a value outside the map rather than picking one of two", () => {
    // The refusal case the catalog's free-string `gender` exists to
    // produce. A non-binary person is not `m` and is not `f`; sending
    // either is a wrong match key, where sending neither is a missing one.
    expect(normalizePerson({ gender: "non-binary" }).gender).toBeNull();
    expect(normalizePerson({ gender: "prefer not to say" }).gender).toBeNull();
    expect(normalizePerson({ gender: "mm" }).gender).toBeNull();
  });
});

describe("normalizePerson: birthday", () => {
  it("converts the catalog's ISO date to the vendors' YYYYMMDD", () => {
    expect(normalizePerson({ birthday: "1990-02-15" }).birthday).toBe("19900215");
    expect(normalizePerson({ birthday: "2000-12-31" }).birthday).toBe("20001231");
  });

  it("refuses a date the calendar does not have", () => {
    // Ingest validation covers `user.identified`, but computed traits and
    // reverse ETL write the same bag without passing through it.
    expect(normalizePerson({ birthday: "1990-02-30" }).birthday).toBeNull();
    expect(normalizePerson({ birthday: "1990-13-01" }).birthday).toBeNull();
    expect(normalizePerson({ birthday: "1990-11-31" }).birthday).toBeNull();
  });

  it("refuses a malformed birthday rather than reading round it", () => {
    expect(normalizePerson({ birthday: "15/02/1990" }).birthday).toBeNull();
    expect(normalizePerson({ birthday: "1990-2-5" }).birthday).toBeNull();
    expect(normalizePerson({ birthday: "" }).birthday).toBeNull();
  });

  it("refuses a datetime rather than deciding whose midnight counts", () => {
    // `2026-01-01T00:00:00-03:00` is 2025-12-31 in UTC. Truncating to the
    // date part picks a day on the producer's behalf, silently, on a value
    // that is then hashed.
    expect(normalizePerson({ birthday: "1990-02-15T00:00:00Z" }).birthday).toBeNull();
  });
});

describe("normalizePerson: absent input", () => {
  it("reports every slot null for an empty bag", () => {
    expect(normalizePerson({})).toEqual({
      first_name: null,
      last_name: null,
      gender: null,
      birthday: null,
    });
  });

  it("treats null and undefined as absent", () => {
    expect(normalizePerson({ first_name: null, gender: undefined }).first_name).toBeNull();
    expect(normalizePerson({ first_name: null, gender: undefined }).gender).toBeNull();
  });
});
