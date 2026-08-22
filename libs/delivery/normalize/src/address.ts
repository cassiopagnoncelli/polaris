/**
 * Address match-key normalization shared across destination consumers.
 *
 * The location half of the extended match set: Meta's `ct`, `st`, `zp`
 * and `country`, and the same four under TikTok's, Reddit's and Snap's
 * spellings. Like the person keys in `person.ts` these are hashed, so the
 * canonical form is what decides whether a person matches at all.
 *
 * The four fields arrive from the `address` bag `user.identified` v1
 * pins, which keeps `country` a free string on purpose: producers send
 * `"Brazil"`, `"BR"` and `"bra"` for the same country and rejecting two
 * of the three at ingest would lose the trait rather than fix it. This is
 * where that is reconciled — and where it is REFUSED when it cannot be,
 * because a country is the one field in the set where a confident guess
 * puts a person in the wrong audience rather than in none.
 *
 * Exposed from the package root and from
 * `@polaris/delivery-normalize/address`, the root being the surface a
 * consumer should take; `person.ts` carries the reasoning for the pair.
 */

/**
 * The address half of the extended match set. Iterated by identity
 * preparation and by the trait-bag normalizer; see `PERSON_MATCH_KEYS`
 * for why the list is exported rather than written out at each caller.
 */
export const ADDRESS_MATCH_KEYS = ["city", "state", "postal_code", "country"] as const;

/** One of the four address match keys. */
export type AddressMatchKey = (typeof ADDRESS_MATCH_KEYS)[number];

/** Raw address match keys, as a producer or a trait snapshot spells them. */
export interface RawAddressMatchKeys {
  readonly city?: string | null | undefined;
  readonly state?: string | null | undefined;
  readonly postal_code?: string | null | undefined;
  readonly country?: string | null | undefined;
}

/**
 * Canonical address match keys. `null` means "absent, or present in a
 * shape this module refuses to guess at".
 */
export interface NormalizedAddressMatchKeys {
  /** Letters and digits only, lowercase. */
  readonly city: string | null;
  /** Letters and digits only, lowercase. */
  readonly state: string | null;
  /** Lowercase, no whitespace; first five characters in the US. */
  readonly postal_code: string | null;
  /** ISO-3166-1 alpha-2, lowercase. */
  readonly country: string | null;
}

/**
 * Canonicalize a city or state name: NFC, lowercase, letters and digits
 * only. `"Menlo Park"` becomes `"menlopark"`, `"São Paulo"` becomes
 * `"sãopaulo"` — the same rule the person names get, for the same reason
 * (see `canonicalizeName` in `person.ts`).
 *
 * A US state arriving spelled out stays spelled out: `"California"`
 * becomes `"california"`, not `"ca"`. Meta's own guidance prefers the
 * two-letter ANSI abbreviation for US states, so this is a match-rate
 * cost taken deliberately — the abbreviation table is a fifty-row guess
 * about which `"WA"` a producer means once other countries have states
 * too, and the rule the platform publishes is one rule for every country.
 * A vendor that wants the abbreviation can map it in its own
 * `normalize/`, which is exactly what that layer is for.
 */
function canonicalizePlaceName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  return stripped.length === 0 ? null : stripped;
}

/**
 * Canonicalize a postal code: lowercase, no whitespace.
 *
 * In the US only, the result is truncated to its first five characters,
 * which turns the ZIP+4 `"94025-1234"` into the `"94025"` Meta hashes.
 * Everywhere else the full code survives, because it is the whole code
 * that identifies the area: truncating a UK `"sw1a1aa"` to `"sw1a1"`
 * would hash something that is not a postcode at all.
 *
 * The US branch is chosen by `country`, which is why this takes the
 * already-canonical country rather than re-deriving it. With no country
 * on the address the full code is kept — sending a whole ZIP+4 costs a
 * match against a vendor holding five digits, while truncating a foreign
 * code on a guess corrupts one that would have matched.
 */
function canonicalizePostalCode(
  value: string | null | undefined,
  country: string | null,
): string | null {
  if (typeof value !== "string") return null;
  const stripped = value.toLowerCase().replace(/\s+/gu, "");
  if (stripped.length === 0) return null;
  return country === "us" ? stripped.slice(0, 5) : stripped;
}

/**
 * Canonicalize a country to ISO-3166-1 alpha-2, lowercase.
 *
 * Three inputs are accepted, in order: an alpha-2 code that is really
 * assigned, a name or abbreviation this module knows, and nothing else.
 * The third case is the point — an unrecognised country returns `null`
 * and the field is not sent. Every other rule in this package degrades to
 * a missing match key when it refuses; this one degrades to a WRONG one
 * if it guesses, because every two-letter string that is not a country
 * code is one letter away from being another country's.
 */
function canonicalizeCountry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const key = lookupKey(value);
  if (key.length === 0) return null;
  if (key.length === 2 && ISO_3166_ALPHA2.has(key)) return key;
  return COUNTRY_ALIASES[key] ?? null;
}

/**
 * Fold a country string to the form the alias table is keyed on: NFD,
 * combining marks dropped, lowercase, letters only. `"México"`,
 * `"MEXICO"` and `"Mexico"` all become `"mexico"`, and `"U.S.A."` becomes
 * `"usa"`.
 *
 * Diacritics are dropped HERE and nowhere else in this package. For a
 * name or a city the accent is part of the value a vendor stored and
 * folding it would change the digest; for a country it is only part of
 * how a producer spelled a lookup key whose answer is two ASCII letters.
 */
function lookupKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/gu, "");
}

/**
 * The assigned ISO-3166-1 alpha-2 codes, as the set membership test for
 * a two-letter input.
 *
 * The complete list rather than a popular subset: a partial list refuses
 * `"lu"` and loses every Luxembourgish person the day someone notices,
 * which is the failure a shortcut here actually produces.
 */
const ISO_3166_ALPHA2: ReadonlySet<string> = new Set(
  (
    "ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq " +
    "br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm " +
    "do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs " +
    "gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn " +
    "kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq " +
    "mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm " +
    "pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv " +
    "sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi " +
    "vn vu wf ws ye yt za zm zw"
  ).split(" "),
);

/**
 * Names, local names and abbreviations that resolve to an alpha-2 code.
 *
 * Deliberately a curated table rather than a generated one. Every row is
 * a claim that a producer writing this string means this country, and the
 * cost of a wrong row is a person delivered into another country's
 * audience — so the table covers the spellings that actually arrive in
 * trait snapshots and stops. `"korea"` is the shape of what is left out:
 * it is two countries, and a guess would be right most of the time and
 * catastrophic the rest.
 *
 * Alpha-3 is here rather than in its own set for the same reason: the
 * codes below are the markets the platform delivers to, not the standard
 * in full. Extending this is a data change with a test beside it.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // North America
  unitedstates: "us",
  unitedstatesofamerica: "us",
  usa: "us",
  canada: "ca",
  can: "ca",
  mexico: "mx",
  mex: "mx",
  // South America
  brazil: "br",
  brasil: "br",
  bra: "br",
  argentina: "ar",
  arg: "ar",
  chile: "cl",
  chl: "cl",
  colombia: "co",
  col: "co",
  peru: "pe",
  per: "pe",
  // Europe
  unitedkingdom: "gb",
  greatbritain: "gb",
  uk: "gb",
  gbr: "gb",
  germany: "de",
  deutschland: "de",
  deu: "de",
  france: "fr",
  fra: "fr",
  spain: "es",
  espana: "es",
  esp: "es",
  italy: "it",
  italia: "it",
  ita: "it",
  portugal: "pt",
  prt: "pt",
  netherlands: "nl",
  holland: "nl",
  nld: "nl",
  belgium: "be",
  bel: "be",
  switzerland: "ch",
  che: "ch",
  austria: "at",
  aut: "at",
  sweden: "se",
  swe: "se",
  norway: "no",
  nor: "no",
  denmark: "dk",
  dnk: "dk",
  finland: "fi",
  fin: "fi",
  ireland: "ie",
  irl: "ie",
  poland: "pl",
  polska: "pl",
  pol: "pl",
  czechia: "cz",
  czechrepublic: "cz",
  cze: "cz",
  greece: "gr",
  grc: "gr",
  turkey: "tr",
  turkiye: "tr",
  tur: "tr",
  russia: "ru",
  russianfederation: "ru",
  rus: "ru",
  ukraine: "ua",
  ukr: "ua",
  // Asia-Pacific
  china: "cn",
  chn: "cn",
  japan: "jp",
  jpn: "jp",
  southkorea: "kr",
  republicofkorea: "kr",
  kor: "kr",
  india: "in",
  ind: "in",
  indonesia: "id",
  idn: "id",
  singapore: "sg",
  sgp: "sg",
  malaysia: "my",
  mys: "my",
  thailand: "th",
  tha: "th",
  vietnam: "vn",
  vnm: "vn",
  philippines: "ph",
  phl: "ph",
  hongkong: "hk",
  hkg: "hk",
  taiwan: "tw",
  twn: "tw",
  australia: "au",
  aus: "au",
  newzealand: "nz",
  nzl: "nz",
  // Africa and the Middle East
  southafrica: "za",
  zaf: "za",
  nigeria: "ng",
  nga: "ng",
  kenya: "ke",
  ken: "ke",
  egypt: "eg",
  egy: "eg",
  israel: "il",
  isr: "il",
  unitedarabemirates: "ae",
  uae: "ae",
  are: "ae",
  saudiarabia: "sa",
  sau: "sa",
});

/**
 * Normalize the address half of the extended match set.
 *
 * `country` is resolved first because `postal_code` needs it: the US is
 * the one country whose code is truncated.
 */
export function normalizeAddress(raw: RawAddressMatchKeys): NormalizedAddressMatchKeys {
  const country = canonicalizeCountry(raw.country);
  return {
    city: canonicalizePlaceName(raw.city),
    state: canonicalizePlaceName(raw.state),
    postal_code: canonicalizePostalCode(raw.postal_code, country),
    country,
  };
}
