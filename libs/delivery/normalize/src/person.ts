/**
 * Person match-key normalization shared across destination consumers.
 *
 * The ad platforms match an event to a person on more than email and
 * phone. Meta's `user_data` takes `fn`, `ln`, `ge` and `db`; TikTok,
 * Reddit and Snap take the same set under their own spellings. All of
 * them hash it, and all of them hash a value they expect to have been
 * canonicalized first — an unnormalized `"  José "` and a normalized
 * `"josé"` are two different SHA-256 digests and therefore two different
 * people, so a mismatch here is not a formatting difference but a lost
 * match.
 *
 * The canonical forms, one rule per field, are Meta's published ones
 * (`developers.facebook.com` → Conversions API → customer information
 * parameters). The other vendors' guidance agrees field for field where
 * they overlap, which is why this lives here rather than in a vendor's
 * `normalize/`.
 *
 * Rules per `docs/architecture/06-destinations.md`:
 *   - deterministic and stateless: same input, same output;
 *   - never logs;
 *   - refuses rather than guesses. A value this module cannot normalize
 *     returns `null`, and the caller drops it. A wrong value is worse
 *     than an absent one: it is matched against somebody else.
 *
 * Reachable both ways, like every other module here: from the package
 * root and from `@polaris/delivery-normalize/person`. Consumers should
 * take the ROOT. `RawIdentityInput` extends the raw type below and
 * leaves through `index.ts`, so a consumer that took the base from the
 * subpath would be naming one type across two surfaces; the root is the
 * one `index.ts` keeps auditable, and `test/export-closure.test.ts`
 * holds it closed. The subpath earns its place anyway, and not for
 * symmetry: the `exports` map is the only list the injected-copy check
 * reads, so a module declared on neither surface can go missing from a
 * copy while the check reports it in sync.
 */

/**
 * The person half of the extended match set, in the order the vendors'
 * documentation lists it.
 *
 * Exported because two callers iterate it — identity preparation and the
 * trait-bag normalizer — and a ninth key added to the rules but not to
 * one of those loops is a field that silently never reaches a vendor.
 * The list lives beside the rules so there is one place to add it.
 */
export const PERSON_MATCH_KEYS = ["first_name", "last_name", "gender", "birthday"] as const;

/** One of the four person match keys. */
export type PersonMatchKey = (typeof PERSON_MATCH_KEYS)[number];

/** Raw person match keys, as a producer or a trait snapshot spells them. */
export interface RawPersonMatchKeys {
  readonly first_name?: string | null | undefined;
  readonly last_name?: string | null | undefined;
  readonly gender?: string | null | undefined;
  readonly birthday?: string | null | undefined;
}

/**
 * Canonical person match keys. `null` means "absent, or present in a
 * shape this module refuses to guess at".
 */
export interface NormalizedPersonMatchKeys {
  /** Letters and digits only, lowercase. */
  readonly first_name: string | null;
  /** Letters and digits only, lowercase. */
  readonly last_name: string | null;
  /** `m` or `f`. Anything else is refused. */
  readonly gender: string | null;
  /** `YYYYMMDD`. */
  readonly birthday: string | null;
}

/**
 * Canonicalize a person's name for hashing.
 *
 * Unicode NFC first, then lowercase, then everything that is not a letter
 * or a digit is removed — spaces, hyphens, apostrophes, honorific dots.
 * `"O'Brien-Smith"` and `"obriensmith"` are the same person to a vendor
 * and must therefore be the same digest.
 *
 * NFC is the half of this rule Meta does not publish and every producer
 * hits: `"José"` typed on macOS is `e` + U+0301, and typed on Windows is
 * U+00E9. They render identically, they compare unequal, and they hash to
 * different values. Composing first makes the digest a property of the
 * name rather than of the keyboard that entered it.
 *
 * Accents are KEPT, not folded to ASCII. Meta asks for "special
 * characters in UTF-8 format", and a vendor that stored `josé` matches
 * `josé`; folding to `jose` would be this layer inventing a different
 * name.
 */
function canonicalizeName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return stripped.length === 0 ? null : stripped;
}

/**
 * Map a producer's gender string onto the vendor vocabulary: `m` or `f`.
 *
 * The catalog deliberately keeps `gender` a free string (see
 * `user.identified` v1) because producers send everything from `"male"`
 * to a survey answer, and the platform's job is to make the value
 * reachable, not to constrain what a project may record. Mapping it to
 * the two tokens the ad platforms accept is this layer's job, and it is
 * the narrow half: Meta's `ge` takes `m` or `f` and nothing else.
 *
 * Anything outside the map returns `null` and the field is simply not
 * sent. That is the honest outcome for a non-binary or unrecorded value —
 * the alternative is picking one of two tokens for a person who is
 * neither, which is a wrong match key rather than a missing one.
 */
function canonicalizeGender(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return GENDER_TOKENS[value.trim().toLowerCase()] ?? null;
}

/**
 * Producer spellings this layer accepts for the two vendor tokens.
 *
 * Short and English-only on purpose. A longer list is a bigger surface on
 * which to be confidently wrong about somebody, and a producer whose
 * spelling is missing loses one match key rather than gaining a wrong
 * one. Extending it is a data change with a test, not a guess at runtime.
 */
const GENDER_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  m: "m",
  male: "m",
  man: "m",
  f: "f",
  female: "f",
  woman: "f",
});

/**
 * Convert an ISO calendar date (`YYYY-MM-DD`) to the vendors' `YYYYMMDD`.
 *
 * The input shape is the one `user.identified` v1 pins, validated at
 * ingest as a real date. It is re-validated here because the catalog is
 * not the only writer of profile traits: computed traits and reverse ETL
 * write the same bag, and neither goes through the event schema.
 * `"1990-02-30"` parses as a shape and is not a day.
 *
 * A datetime is REFUSED rather than truncated to its date part. A
 * birthday carried as `2026-01-01T00:00:00-03:00` is 2025-12-31 in UTC
 * and 2026-01-01 locally, and picking either makes this layer decide
 * whose midnight counts — a silent off-by-one-day on a match key. The
 * producer knows which day it is; this layer does not.
 */
function canonicalizeBirthday(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  // `new Date("2025-02-30")` is Invalid, but `new Date("2025-11-31")`
  // rolls forward to December 1 in some engines; comparing the parsed
  // parts back is what refuses a day the month does not have.
  if (date.getUTCFullYear() !== Number(year)) return null;
  if (date.getUTCMonth() + 1 !== Number(month)) return null;
  if (date.getUTCDate() !== Number(day)) return null;
  return `${year}${month}${day}`;
}

/**
 * Normalize the person half of the extended match set.
 *
 * Absent, empty and unnormalizable inputs all produce `null` on their
 * slot; the caller cannot tell them apart and does not need to, since all
 * three mean "do not send this field to the vendor".
 */
export function normalizePerson(raw: RawPersonMatchKeys): NormalizedPersonMatchKeys {
  return {
    first_name: canonicalizeName(raw.first_name),
    last_name: canonicalizeName(raw.last_name),
    gender: canonicalizeGender(raw.gender),
    birthday: canonicalizeBirthday(raw.birthday),
  };
}
