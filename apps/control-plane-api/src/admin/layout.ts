/**
 * Page chrome and the stylesheet.
 *
 * The stylesheet is a TypeScript constant served from a route rather than a
 * `.css` file, for the same reason the markup is: the Dockerfile copies only
 * `tsc` output (see `html.ts`). Serving it as a route instead of inlining a
 * `<style>` block keeps `style-src 'self'` in the CSP honest — no
 * `unsafe-inline` needed.
 *
 * Every page renders the environment of the thing being looked at. The most
 * common serious operator error in a tool like this is acting on production
 * while believing it is staging, so the badge is loud and `production` is
 * red — in the header for the service, and per row wherever rows carry their
 * own environment.
 */

import { type Html, html, raw, render } from "./html.js";
import type { PlatformRoleName } from "./platform-role.js";
import { ADMIN_PREFIX, AUTH_PREFIX } from "./session.js";
import { type AdminTheme, DEFAULT_THEME, THEME_OPTIONS } from "./theme.js";

export interface AdminPageContext {
  /** Environment of the *service* — what this control plane is fronting. */
  readonly environment: string;
  readonly email: string | null;
  readonly role: PlatformRoleName;
  readonly requestId: string;
  /** Path of the current page, for nav highlighting. */
  readonly path: string;
  /**
   * Where a theme change should land the operator — this view, with its
   * filters intact. Not always `path`: see `plugin.ts`.
   */
  readonly returnTo: string;
  readonly theme: AdminTheme;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * Nav groups, rendered in the header with a rule between them.
 *
 * The first group is the pipeline an operator is usually here to change —
 * where data comes from, what happens to it, where it lands, in that order.
 * The second is what you reach for when something has gone wrong or needs
 * accounting for. Keeping them apart means the routine path never has to be
 * picked out of the incident path.
 *
 * There is no Overview entry: the Polaris wordmark to the left already links
 * there, and a nav that repeats the home link teaches operators that one of
 * the two does something else.
 */
const NAV_GROUPS: ReadonlyArray<ReadonlyArray<NavItem>> = [
  [
    { href: `${ADMIN_PREFIX}/projects`, label: "Projects" },
    { href: `${ADMIN_PREFIX}/processors`, label: "Processors" },
    { href: `${ADMIN_PREFIX}/destinations`, label: "Destinations" },
  ],
  [
    { href: `${ADMIN_PREFIX}/keys`, label: "API keys" },
    { href: `${ADMIN_PREFIX}/dlq`, label: "DLQ" },
    { href: `${ADMIN_PREFIX}/audit`, label: "Audit" },
  ],
];

/** A coloured environment chip. `production` is deliberately alarming. */
export function envBadge(environment: string | null | undefined): Html {
  if (environment === null || environment === undefined || environment.length === 0) {
    return html`<span class="badge badge-muted">—</span>`;
  }
  const cls = environment === "production" ? "badge badge-prod" : "badge";
  return html`<span class="${cls}">${environment}</span>`;
}

/** A status chip, coloured by whether the status is a healthy one. */
export function statusBadge(status: string | null | undefined): Html {
  if (status === null || status === undefined || status.length === 0) {
    return html`<span class="badge badge-muted">—</span>`;
  }
  const good = status === "active" || status === "enabled" || status === "completed";
  const bad =
    status === "revoked" || status === "disabled" || status === "failed" || status === "cancelled";
  const cls = good ? "badge badge-ok" : bad ? "badge badge-bad" : "badge";
  return html`<span class="${cls}">${status}</span>`;
}

/** Monospaced identifier, so ids and hashes line up in tables. */
export function mono(value: string | null | undefined): Html {
  if (value === null || value === undefined || value.length === 0) {
    return html`<span class="muted">—</span>`;
  }
  return html`<code>${value}</code>`;
}

/**
 * A neutral chip for a value from a closed set that is neither healthy nor
 * unhealthy — a destination's `mode`, say. `statusBadge` would have to invent
 * a verdict about it; this one just labels.
 */
export function valueBadge(value: string | null | undefined): Html {
  if (value === null || value === undefined || value.length === 0) {
    return html`<span class="badge badge-muted">—</span>`;
  }
  return html`<span class="badge">${value}</span>`;
}

/** The breadcrumb above the `h1`. Renders nothing when a page has no trail. */
function crumbs(trail: readonly Crumb[] | undefined): Html | null {
  if (trail === undefined || trail.length === 0) return null;
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    ${trail.map((crumb, index) => [
      index > 0 ? html`<span class="crumb-sep" aria-hidden="true">/</span>` : null,
      crumb.href === undefined
        ? html`<span aria-current="page">${crumb.label}</span>`
        : html`<a href="${crumb.href}">${crumb.label}</a>`,
    ])}
  </nav>`;
}

/**
 * A labelled figure in the row of cards a detail page opens with.
 *
 * `mono` is for values from a closed set (`standard`, `live`) — they read as
 * identifiers rather than quantities, and setting them at the size of a
 * three-digit number makes a word shout.
 */
export function statCard(input: {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}): Html {
  const body = html`<div class="${input.mono === true ? "v" : "n"}">${input.value}</div>
    <div class="k">${input.label}</div>`;
  return html`<div class="card-stat">
    ${input.href === undefined ? body : html`<a href="${input.href}" class="card-link">${body}</a>`}
  </div>`;
}

/** A card linking to a filtered view of another page, with its own one-line why. */
export function linkCard(input: { href: string; title: string; description: string }): Html {
  return html`<a href="${input.href}" class="linkcard">
    <span class="t">${input.title}</span>
    <span class="d">${input.description}</span>
  </a>`;
}

/** Rendered when a filtered list comes back empty. */
export function emptyRow(columns: number, message: string): Html {
  return html`<tr>
    <td colspan="${String(columns)}" class="empty">${message}</td>
  </tr>`;
}

/**
 * The signed-in operator's menu: who they are, what they can do, how the panel
 * looks, and the way out.
 *
 * A `<details>` element because the panel ships no JavaScript. The trade is
 * one real limitation — clicking elsewhere on the page does not close it, only
 * clicking the trigger again does — in exchange for a menu that cannot break,
 * and a CSP with no `script-src` exception to justify.
 *
 * The role sits next to the email rather than in the topbar because the two
 * answer the same question: who is about to press the button. Splitting them
 * meant reading the identity in one corner and the authority in another.
 */
function userMenu(ctx: AdminPageContext): Html {
  const who = ctx.email ?? "signed in";

  // One line per button on purpose: a `<button>` broken across lines puts
  // whitespace inside its label, which then has to be trimmed by everything
  // that reads it back.
  const themeButtons = THEME_OPTIONS.map((option) => {
    const current = option.value === ctx.theme;
    const cls = current ? "theme-option current" : "theme-option";
    return html`<button type="submit" name="theme" value="${option.value}" class="${cls}" aria-pressed="${current ? "true" : "false"}">${option.label}</button>`;
  });

  return html`<details class="usermenu">
    <summary class="usermenu-trigger" aria-label="Account menu">
      <span class="usermenu-who">${who}</span>
      <span class="usermenu-caret" aria-hidden="true">▾</span>
    </summary>
    <div class="usermenu-panel">
      <div class="usermenu-identity">
        <span class="usermenu-email">${who}</span>
        <span class="badge badge-muted">${ctx.role}</span>
      </div>
      <form method="post" action="${ADMIN_PREFIX}/preferences/theme" class="usermenu-theme">
        <input type="hidden" name="next" value="${ctx.returnTo}" />
        ${themeButtons}
      </form>
      <form method="post" action="${AUTH_PREFIX}/logout">
        <button type="submit" class="usermenu-signout">Sign out</button>
      </form>
    </div>
  </details>`;
}

/** One step of a breadcrumb. The last step is the current page and has no href. */
export interface Crumb {
  readonly label: string;
  readonly href?: string | undefined;
}

export interface PageInput {
  readonly ctx: AdminPageContext;
  /** Document title, and the `h1` unless `heading` overrides it. */
  readonly title: string;
  readonly body: Html;
  /**
   * Trail above the `h1`.
   *
   * A detail page is reached from a list, and the nav highlight alone does not
   * say which row is open or how to get back to the others.
   */
  readonly breadcrumb?: readonly Crumb[] | undefined;
  /**
   * `h1` text when it should differ from the document title — a tab reading
   * `ga4 · storefront-prod` disambiguates between open tabs, where the same
   * string as a heading just restates the breadcrumb.
   */
  readonly heading?: string | undefined;
  /** One line under the `h1`: what this row is, and what state it is in. */
  readonly lede?: Html | undefined;
}

/** Full HTML document. */
export function page(input: PageInput): string {
  const { ctx } = input;
  // Every group after the first is introduced by its divider, so the rule is
  // only ever between groups and never trailing.
  const nav = NAV_GROUPS.flatMap((group, index) => [
    index > 0 ? html`<span class="nav-divider" aria-hidden="true"></span>` : null,
    ...group.map((item) => {
      const current = ctx.path.startsWith(item.href);
      return html`<a href="${item.href}" class="${current ? "nav-link current" : "nav-link"}"
        >${item.label}</a
      >`;
    }),
  ]);

  return render(html`<!doctype html>
<html lang="en" data-theme="${ctx.theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${input.title} · Polaris admin</title>
    <link rel="stylesheet" href="${ADMIN_PREFIX}/assets/app.css" />
  </head>
  <body>
    <header class="topbar">
      <div class="topbar-left">
        <a href="${ADMIN_PREFIX}" class="brand">Polaris</a>
        ${envBadge(ctx.environment)}
        <nav class="nav" aria-label="Sections">${nav}</nav>
      </div>
      <div class="topbar-right">${userMenu(ctx)}</div>
    </header>
    <main>
      <div class="page-head">
        ${crumbs(input.breadcrumb)}
        <h1>${input.heading ?? input.title}</h1>
        ${input.lede !== undefined ? html`<div class="page-lede">${input.lede}</div>` : null}
      </div>
      ${input.body}
    </main>
    <footer class="footer">
      <span>request ${ctx.requestId}</span>
      <span
        >Time-series metrics live in Grafana — this panel is control-plane state
        only.</span
      >
    </footer>
  </body>
</html>`);
}

/**
 * Standalone page for the pre-session routes (login, forbidden, signed out).
 *
 * Always follows the operating system. These pages are reached either before
 * there is a session to hold a preference or when one has just ended, so
 * threading the cookie through every caller would buy consistency on the two
 * screens where nobody is looking at it.
 */
export function barePage(title: string, body: Html): string {
  return render(html`<!doctype html>
<html lang="en" data-theme="${DEFAULT_THEME}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title} · Polaris admin</title>
    <link rel="stylesheet" href="${ADMIN_PREFIX}/assets/app.css" />
  </head>
  <body class="centered">
    <main class="card">
      <div class="brand brand-lg">Polaris</div>
      <h1>${title}</h1>
      ${body}
    </main>
  </body>
</html>`);
}

/**
 * Two palettes behind one set of custom properties.
 *
 * Dark is the base declaration, so a document that somehow arrives without a
 * `data-theme` still renders the panel operators know rather than an unstyled
 * one. `light` and `dark` are pins that beat the OS; `system` is the only
 * value the media query is allowed to touch.
 *
 * Every colour a rule needs is a variable, including the ones that read as
 * incidental — badge borders, notice text, the ink on a filled button. A
 * hardcoded `#08111f` for button text is invisible on dark and unreadable on
 * light, and that class of bug is only avoidable by not having the literal.
 */
export const STYLESHEET = raw(`
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #161a21;
  --panel-2: #1c212a;
  --line: #272d38;
  --text: #dfe3ea;
  --muted: #8b94a4;
  --accent: #5b9dff;
  --accent-ink: #08111f;
  --ok: #3fb950;
  --ok-line: #23502c;
  --bad: #f85149;
  --bad-line: #5c2321;
  --prod: #d1242f;
  --error-text: #ffb4ae;
  --warn-line: #5c4a21;
  --warn-text: #ffd9a0;
  --shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --panel-2: #eceef2;
  --line: #d5dae2;
  --text: #1b1f27;
  --muted: #5c6472;
  --accent: #1f6feb;
  --accent-ink: #ffffff;
  --ok: #14733a;
  --ok-line: #a9d7b8;
  --bad: #c02a30;
  --bad-line: #edb3b1;
  --prod: #c02a30;
  --error-text: #8c1d1a;
  --warn-line: #e2c893;
  --warn-text: #7a5410;
  --shadow: 0 12px 28px rgba(16, 22, 34, 0.16);
}
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] {
    color-scheme: light;
    --bg: #f5f6f8;
    --panel: #ffffff;
    --panel-2: #eceef2;
    --line: #d5dae2;
    --text: #1b1f27;
    --muted: #5c6472;
    --accent: #1f6feb;
    --accent-ink: #ffffff;
    --ok: #14733a;
    --ok-line: #a9d7b8;
    --bad: #c02a30;
    --bad-line: #edb3b1;
    --prod: #c02a30;
    --error-text: #8c1d1a;
    --warn-line: #e2c893;
    --warn-text: #7a5410;
    --shadow: 0 12px 28px rgba(16, 22, 34, 0.16);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--text);
}
/* Ids are rendered as <code> inside the link that opens them, and a <code>
   with its own colour turns the whole first column of every list into text
   that happens to be clickable. */
a code { color: inherit; }
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; padding: 10px 20px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
.topbar-left, .topbar-right { display: flex; align-items: center; gap: 10px; }
.topbar-left { flex-wrap: wrap; }
/* Stays at the right edge even on the wrapped row it gets to itself, which is
   what the menu panel below anchors to. */
.topbar-right { margin-left: auto; }
.brand { font-weight: 700; letter-spacing: 0.02em; color: var(--text); }
.brand-lg { font-size: 20px; margin-bottom: 12px; }
.usermenu { position: relative; }
.usermenu-trigger {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  padding: 5px 10px; border-radius: 6px; color: var(--muted);
  border: 1px solid transparent; list-style: none; user-select: none;
}
/* Safari draws its own disclosure triangle unless this is turned off. */
.usermenu-trigger::-webkit-details-marker { display: none; }
.usermenu-trigger:hover { background: var(--panel-2); color: var(--text); }
.usermenu-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.usermenu[open] .usermenu-trigger { background: var(--panel-2); color: var(--text); }
.usermenu-who { max-width: 24ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usermenu-caret { font-size: 12px; line-height: 1; }
.usermenu[open] .usermenu-caret { transform: rotate(180deg); }
.usermenu-panel {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 20;
  min-width: 240px; max-width: calc(100vw - 40px); padding: 6px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 8px; box-shadow: var(--shadow);
}
.usermenu-identity {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 10px;
}
.usermenu-email { color: var(--text); overflow-wrap: anywhere; }
.usermenu-theme { display: flex; gap: 4px; padding: 4px 10px 8px; }
.theme-option {
  flex: 1; background: var(--panel-2); color: var(--muted);
  border: 1px solid var(--line); border-radius: 6px;
  padding: 5px 0; font-size: 12px; font-weight: 500;
}
.theme-option:hover { color: var(--text); filter: none; }
.theme-option.current {
  background: var(--accent); border-color: var(--accent);
  color: var(--accent-ink); font-weight: 600;
}
.usermenu-signout {
  width: 100%; text-align: left; background: none; color: var(--text);
  padding: 8px 10px; font-weight: 500;
}
.usermenu-signout:hover { background: var(--panel-2); filter: none; }
.nav { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; margin-left: 8px; }
.nav-divider { width: 1px; height: 18px; margin: 0 8px; background: var(--line); flex: none; }
.nav-link { padding: 5px 10px; border-radius: 6px; color: var(--muted); white-space: nowrap; }
.nav-link:hover { background: var(--panel-2); color: var(--text); text-decoration: none; }
.nav-link.current { background: var(--panel-2); color: var(--text); }
main { padding: 22px 20px 40px; max-width: 1400px; }
h1 { font-size: 20px; margin: 0 0 18px; font-weight: 650; }
h2 { font-size: 15px; margin: 26px 0 10px; font-weight: 650; color: var(--muted);
     text-transform: uppercase; letter-spacing: 0.06em; }
/* The heading block owns the gap below it, so an h1 with a lede under it and a
   bare h1 leave the same space before the body. */
.page-head { margin-bottom: 18px; }
.page-head h1 { margin-bottom: 0; }
.crumbs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          margin-bottom: 7px; font-size: 12px; color: var(--muted); }
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--text); }
.crumb-sep { opacity: 0.55; }
.page-lede { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
             margin-top: 8px; color: var(--muted); font-size: 13px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line);
         white-space: nowrap; }
th { background: var(--panel-2); color: var(--muted); font-weight: 600;
     font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--panel); }
td.empty { text-align: center; color: var(--muted); padding: 28px; white-space: normal; }
td.wrap, th.wrap { white-space: normal; }
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--line);
  font-size: 11px; letter-spacing: 0.03em;
}
.badge-prod { background: var(--prod); border-color: var(--prod); color: #fff; font-weight: 700; }
.badge-ok { color: var(--ok); border-color: var(--ok-line); }
.badge-bad { color: var(--bad); border-color: var(--bad-line); }
.badge-muted { color: var(--muted); }
.muted { color: var(--muted); }
.cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.card-stat {
  flex: 1 1 150px; padding: 14px 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px;
}
/* One band for the value whatever its size, so a row mixing a two-digit
   number with a word keeps its labels on one line. */
.card-stat .n, .card-stat .v { display: flex; align-items: center; min-height: 34px; }
.card-stat .n { font-size: 26px; font-weight: 650; }
.card-stat .v { font-size: 15px; font-weight: 600;
                font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.card-stat .k { color: var(--muted); font-size: 12px; text-transform: uppercase;
                letter-spacing: 0.05em; }
.card-link { color: inherit; display: block; }
.card-link:hover { text-decoration: none; }
/* Configured values, not measurements. The overview's counts are the thing
   being reported; these are settings, and setting them at the same size makes
   a detail page read like a dashboard it is not. */
.cards.compact .card-stat { padding: 11px 14px; }
.cards.compact .card-stat .n { font-size: 20px; }
.linkrow { display: flex; gap: 10px; flex-wrap: wrap; }
.linkcard {
  flex: 1 1 240px; display: flex; flex-direction: column; gap: 3px;
  padding: 12px 14px; background: var(--panel); color: var(--text);
  border: 1px solid var(--line); border-radius: 8px;
}
.linkcard:hover { border-color: var(--accent); text-decoration: none; }
.linkcard .t { color: var(--accent); font-weight: 600; }
.linkcard .d { color: var(--muted); font-size: 12px; }
.provenance { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 22px;
              color: var(--muted); font-size: 12px; }
form.filters {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 14px;
}
form.filters label { display: flex; flex-direction: column; gap: 4px;
                     font-size: 12px; color: var(--muted); }
/* A mutation form is a gate, not a filter bar: one field per line, at a width
   that shows the whole confirmation string being typed, inside a card whose
   border says how far the danger extends. */
.action-form {
  display: grid; gap: 13px; max-width: 620px; padding: 16px 18px; margin: 0 0 12px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
}
.action-form.danger { border-color: var(--bad-line); }
.action-form p { margin: 0; }
.action-form .notice { margin-bottom: 0; }
.action-form label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
.action-form input { width: 100%; min-width: 0; }
.action-form button { justify-self: start; }
input, select, textarea {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px;
  font: inherit; min-width: 150px;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  background: var(--accent); color: var(--accent-ink); border: 0; border-radius: 6px;
  padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer;
}
button:hover { filter: brightness(1.08); }
button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
button.danger { background: var(--bad); color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.link-button { background: none; color: var(--muted); padding: 4px 6px; font-weight: 500; }
.link-button:hover { color: var(--text); filter: none; text-decoration: underline; }
.footer {
  display: flex; gap: 18px; flex-wrap: wrap;
  padding: 14px 20px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 12px;
}
.detail { display: grid; grid-template-columns: 200px 1fr; gap: 0;
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.detail dt { padding: 8px 12px; background: var(--panel-2); color: var(--muted);
             border-bottom: 1px solid var(--line); font-size: 12px; }
.detail dd { padding: 8px 12px; margin: 0; border-bottom: 1px solid var(--line);
             overflow-wrap: anywhere; }
.detail dt:last-of-type, .detail dd:last-of-type { border-bottom: none; }
/* Below this the label column steals the width the value needs — a secret ref
   or a destination id wraps to four lines beside a one-word label. */
@media (max-width: 640px) {
  .detail { grid-template-columns: 1fr; }
  .detail dt { padding-bottom: 3px; border-bottom: none; background: transparent; }
  .detail dd { padding-top: 0; }
}
pre {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
  padding: 12px; overflow-x: auto; font-size: 12px; margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.notice { padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line);
          background: var(--panel); margin-bottom: 16px; }
.notice.error { border-color: var(--bad-line); color: var(--error-text); }
.notice.warn { border-color: var(--warn-line); color: var(--warn-text); }
/* Operator-authored text inside a notice, kept off the platform's own line. */
.notice-detail { display: block; margin-top: 6px; }
.pager { display: flex; gap: 10px; margin-top: 14px; align-items: center; }
body.centered { display: flex; min-height: 100vh; align-items: center; justify-content: center; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 28px 32px; max-width: 460px; width: 100%;
}
.card h1 { font-size: 17px; }
.card p { color: var(--muted); }
.cli {
  display: block; background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 6px; padding: 12px; overflow-x: auto; white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
`);
