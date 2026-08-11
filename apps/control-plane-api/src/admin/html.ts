/**
 * HTML rendering without a template engine.
 *
 * The admin UI is server-rendered HTML. It cannot use a template engine that
 * loads files at runtime: `apps/control-plane-api/Dockerfile` builds with
 * `pnpm --filter … deploy --prod /deploy` and has **no asset-copy step**, so
 * only what `tsc` emits reaches the image. Markup has to be TypeScript.
 *
 * Which leaves the escaping problem. Everything rendered here is either
 * operator-authored (`reason`, `disabled_reason`, `operator_label`) or
 * producer-influenced (audit `before`/`after` JSON), so the safe default has
 * to be escaping, with an explicit opt-out — not the other way round.
 *
 *   html`<td>${row.reason}</td>`              → escaped
 *   html`<tr>${rows.map(rowHtml)}</tr>`       → arrays join, each part escaped
 *   html`${raw(STYLESHEET)}`                  → verbatim, the only unsafe door
 *
 * `raw()` appears in exactly one place (`layout.ts`, for the inline SVG icon
 * and the stylesheet link). Grep for it before trusting any page.
 */

/** Branded so interpolating an `Html` value does not double-escape it. */
export interface Html {
  readonly __html: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape the five characters that can break out of an HTML text node or a
 * quoted attribute value.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Mark a string as already-safe HTML. The only way to bypass escaping. */
export function raw(value: string): Html {
  return { __html: value };
}

/** Unwrap to the string that goes on the wire. */
export function render(node: Html): string {
  return node.__html;
}

function isHtml(value: unknown): value is Html {
  return typeof value === "object" && value !== null && "__html" in value;
}

function interpolate(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (isHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  return escapeHtml(String(value));
}

/**
 * Tagged template producing escaped HTML.
 *
 * `null`, `undefined`, and `false` render as empty strings so
 * `${cond && html`…`}` and `${maybeRow}` both work without a ternary.
 */
export function html(strings: TemplateStringsArray, ...values: readonly unknown[]): Html {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    // `noUncheckedIndexedAccess` — the final `values[i]` is always undefined,
    // which `interpolate` renders as "".
    out += strings[i] ?? "";
    if (i < values.length) out += interpolate(values[i]);
  }
  return { __html: out };
}

/**
 * Pretty-print a JSON-ish value for display inside a `<pre>`.
 *
 * Returns a plain string, so the caller still passes it through `html` and it
 * still gets escaped. Used for `audit_records.before` / `after`, which are
 * jsonb columns holding operational snapshots.
 */
export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    // Postgres jsonb arrives already parsed via the pg driver, but a string
    // column holding JSON should still render readably.
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    return JSON.stringify(parsed, null, 2) ?? "";
  } catch {
    return typeof value === "string" ? value : String(value);
  }
}
