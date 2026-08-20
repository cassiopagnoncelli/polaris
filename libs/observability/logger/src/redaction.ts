/**
 * Default redaction path list for Polaris loggers.
 *
 * Polaris services emit structured JSON logs through Pino. The list below is the
 * baked-in defense against accidentally leaking secrets, PII card data, session
 * material, or raw event payloads through log lines. It is intentionally broad
 * and covers:
 *
 *   - passwords in any common spelling (`password`, `passwd`, `pwd`)
 *   - authorization headers, proxy-authorization, API key headers, cookie /
 *     set-cookie pairs in both `req` / `res` and bare `headers` shapes
 *   - generic secret / token / key fields (`token`, `access_token`, `refresh_token`,
 *     `id_token`, `bearer_token`, `client_secret`, `api_secret`, `api_key`,
 *     `private_key`, `priv_key`, `secret`, `secrets[*]`)
 *   - card data (`cvv`, `cvc`, `card_security_code`, `card_number`,
 *     `card_number_full`, `pan`) on both the top level and the standard nested
 *     `properties.*` slot
 *   - event envelope payloads — the engineering standards forbid logging raw
 *     event `properties` by default. Operators wanting full payload logs must
 *     bypass redaction deliberately at the call site.
 *
 * Pattern-based detection (Luhn-valid PAN, AWS/GitHub token shapes, JWT shape,
 * generic high-entropy) lives in the forbidden-field policy evaluator
 * (`libs/governance/`) and happens before any event is emitted to the
 * log. Logger redaction is the second line of defense for log lines that may
 * still contain a stray field name.
 *
 * @see docs/architecture/09-engineering-standards.md "Logging"
 * @see docs/architecture/01-event-contract.md "Forbidden-Field Policy"
 */

/**
 * Sentinel string substituted for redacted values in JSON logs. Stable across
 * versions so log consumers (Loki, Grafana, internal scrubbers) can detect
 * redactions without reparsing.
 */
export const REDACTION_CENSOR = "[REDACTED]";

/**
 * Default Pino redaction paths.
 *
 * Paths use Pino's redact syntax: dot-style with `*` and `[*]` wildcards.
 * Bracket notation is required for keys containing `-` or `.` (e.g. `set-cookie`).
 *
 * Order is not semantically significant; Pino compiles paths into a fast lookup.
 * The list is exported as a readonly array so consumers cannot mutate it.
 */
export const DEFAULT_REDACTION_PATHS: readonly string[] = Object.freeze([
  // --- Passwords --------------------------------------------------------------
  "password",
  "passwd",
  "pwd",
  "*.password",
  "*.passwd",
  "*.pwd",
  "properties.password",
  "properties.passwd",
  "properties.pwd",
  "body.password",
  "body.passwd",
  "body.pwd",
  "query.password",
  "query.passwd",
  "query.pwd",

  // --- Authorization / API key headers ---------------------------------------
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'headers["x-auth-token"]',
  "req.headers.authorization",
  "req.headers.Authorization",
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'req.headers["x-polaris-api-key"]',
  "request.headers.authorization",
  "request.headers.Authorization",
  'request.headers["x-api-key"]',
  'request.headers["x-polaris-api-key"]',

  // --- Cookies ---------------------------------------------------------------
  "cookie",
  "cookies",
  "Cookie",
  "set-cookie",
  "setCookie",
  "session_cookie",
  "sessionCookie",
  "headers.cookie",
  "headers.Cookie",
  'headers["set-cookie"]',
  "req.headers.cookie",
  "req.headers.Cookie",
  'req.headers["set-cookie"]',
  "res.headers.cookie",
  'res.headers["set-cookie"]',
  "response.headers.cookie",
  'response.headers["set-cookie"]',

  // --- Generic tokens / secrets / keys ---------------------------------------
  "token",
  "tokens",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "id_token",
  "idToken",
  "bearer",
  "bearer_token",
  "bearerToken",
  "secret",
  "secrets",
  "secrets[*]",
  "client_secret",
  "clientSecret",
  "api_key",
  "apiKey",
  "api_secret",
  "apiSecret",
  "private_key",
  "privateKey",
  "priv_key",
  "privKey",
  "*.token",
  "*.access_token",
  "*.accessToken",
  "*.refresh_token",
  "*.refreshToken",
  "*.id_token",
  "*.idToken",
  "*.client_secret",
  "*.clientSecret",
  "*.api_key",
  "*.apiKey",
  "*.api_secret",
  "*.apiSecret",
  "*.private_key",
  "*.privateKey",
  "*.priv_key",
  "*.secret",
  "*.password",
  "config.secret",
  "config.token",
  "config.api_key",
  "config.apiKey",
  "config.private_key",
  "config.privateKey",
  "context.token",
  "context.api_key",
  "context.apiKey",

  // --- Card / payment data ---------------------------------------------------
  "cvv",
  "cvc",
  "card_security_code",
  "cardSecurityCode",
  "card_number",
  "cardNumber",
  "card_number_full",
  "cardNumberFull",
  "pan",
  "*.cvv",
  "*.cvc",
  "*.card_security_code",
  "*.cardSecurityCode",
  "*.card_number",
  "*.cardNumber",
  "*.card_number_full",
  "*.cardNumberFull",
  "*.pan",
  "properties.cvv",
  "properties.cvc",
  "properties.card_security_code",
  "properties.cardSecurityCode",
  "properties.card_number",
  "properties.cardNumber",
  "properties.card_number_full",
  "properties.cardNumberFull",
  "properties.pan",
  "body.cvv",
  "body.cvc",
  "body.card_number",
  "body.cardNumber",
  "body.card_number_full",

  // --- Event envelope payload -------------------------------------------------
  // Architectural rule: do not log raw event `properties` by default.
  // The engineering standards (docs/architecture/09-engineering-standards.md
  // "Logging") require explicit debug-gated, redacted opt-in for full payloads.
  // Logger redaction enforces the default here; callers must use a child
  // logger with `redact.remove = true` and a deliberate guard to bypass.
  "event.properties",
  "events[*].properties",
  "raw.properties",
  "envelope.properties",
]);

/**
 * Resolve the effective redaction path list for a logger.
 *
 * `additionalPaths` are appended to the platform defaults so individual
 * services can extend (never narrow) the bake-in list. Duplicate paths are
 * de-duplicated to keep the resulting redactor compact.
 */
export function resolveRedactionPaths(additionalPaths?: readonly string[]): string[] {
  if (!additionalPaths || additionalPaths.length === 0) {
    return [...DEFAULT_REDACTION_PATHS];
  }
  const seen = new Set<string>(DEFAULT_REDACTION_PATHS);
  for (const path of additionalPaths) {
    seen.add(path);
  }
  return [...seen];
}
