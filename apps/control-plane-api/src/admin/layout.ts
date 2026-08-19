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

/**
 * One entry in a page's tab strip.
 *
 * `count` is what makes tabs affordable. A tab hides its contents by
 * definition, so a strip without counts costs the operator the one thing a
 * long scrolling page gave away for free — whether there is anything in there
 * at all. `alert` is the other half: a state that is *wrong* must not be
 * discoverable only by clicking the tab it happens to live behind.
 */
export interface PageTab {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
  /** How many things are behind this tab. Rendered as a neutral chip. */
  readonly count?: number | undefined;
  /** How many of them are in a broken state, and what that state is. */
  readonly alert?: { readonly count: number; readonly label: string } | undefined;
}

/**
 * A page's tab strip: server-rendered links, not controls.
 *
 * Same reasoning as the environment pills inside the Variables panel — the
 * panel ships no JavaScript, so switching section is a navigation, with a URL
 * an operator can bookmark and paste into an incident channel. `aria-current`
 * rather than `role="tab"` for exactly that reason: these are links to pages,
 * and announcing them as a tablist would promise arrow-key behaviour that a
 * document with no script cannot deliver.
 *
 * Underlines here, pills in the panel. The two levels have to look unalike:
 * this row picks what the page is showing, the row inside Variables picks
 * which environment's values are shown, and rendering both as pills invites
 * reading them as one flat set of six choices.
 */
export function tabStrip(input: { label: string; tabs: readonly PageTab[] }): Html {
  // One line per anchor, like the theme buttons above: the chips are flex
  // siblings of the label, and a `<a>` broken across lines puts the source's
  // own indentation between them on top of the gap the rule already sets.
  const links = input.tabs.map((tab) => {
    const alert = tab.alert;
    const count =
      tab.count === undefined ? null : html`<span class="tab-count">${String(tab.count)}</span>`;
    const flag =
      alert === undefined || alert.count === 0
        ? null
        : html`<span class="tab-count alert" title="${alert.label}">${String(alert.count)}</span>`;
    return html`<a href="${tab.href}" class="${tab.current ? "tab current" : "tab"}" aria-current="${tab.current ? "page" : "false"}"><span>${tab.label}</span>${count}${flag}</a>`;
  });

  return html`<nav class="tabs" aria-label="${input.label}">${links}</nav>`;
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
  /**
   * Section tabs under the heading, from `tabStrip`.
   *
   * Chrome rather than body: it navigates between views of the same subject,
   * which is the heading block's job, and putting it here means one rule owns
   * the space between the title and whatever is showing.
   */
  readonly tabs?: Html | undefined;
  /**
   * Controls acting on the thing the `h1` names, on the line beside it.
   *
   * A page's one destructive action belongs where its subject is named. Below
   * the configuration, the limits and the related links, it is out of sight on
   * a page an operator opened precisely to use it.
   */
  readonly titleAction?: Html | undefined;
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
        <div class="page-title">
          <h1>${input.heading ?? input.title}</h1>
          ${input.titleAction ?? null}
        </div>
        ${input.lede !== undefined ? html`<div class="page-lede">${input.lede}</div>` : null}
      </div>
      ${input.tabs ?? null} ${input.body}
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
/* The title and whatever acts on it share a line. \`baseline\` rather than
   \`center\` so the button sits on the heading's own line rather than floating
   against the ascenders of a heading that wrapped. */
.page-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
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
/* The filter bar.

   One recessed strip rather than loose controls on the page background: it
   reads as a single instrument acting on the table below it, and it stops a
   row of four selects from looking like a form the operator has to fill in
   before anything will show. */
form.filters {
  display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;
  margin-bottom: 14px; padding: 12px 14px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
}
form.filters label {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.05em; font-weight: 600;
}
form.filters select, form.filters input { min-width: 170px; }
/* Pushed to the far end, so the controls read left-to-right and the two
   things that act on them are together and last. */
.filter-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
/* A checkbox is one line, not a caption above a control. */
form.filters label.filter-check {
  flex-direction: row; align-items: center; gap: 7px;
  text-transform: none; letter-spacing: 0; font-size: 13px; font-weight: 500;
  color: var(--text); align-self: center;
}
form.filters label.filter-check input { min-width: auto; }
/* How much of the table the filter is hiding, said once above it. */
.filter-count { margin: 0 0 10px; font-size: 12px; }
/* Explanatory copy, held to a readable measure. A table wants the full 1400px
   the layout allows; a paragraph explaining it does not — at that width the
   eye loses the line it was on coming back from the right edge. */
.prose { max-width: 92ch; }
/* A mutation form is a gate, not a filter bar: one field per line, at a width
   that shows the whole confirmation string being typed, inside a card whose
   border says how far the danger extends. */
.action-form {
  display: grid; gap: 13px; max-width: 620px; padding: 16px 18px; margin: 0 0 12px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
}
.action-form.danger { border-color: var(--bad-line); }
.action-form p { margin: 0; }
/* The Variables panel.

   \`.inline\` is the everyday edit: a value, a reason, a button on one row
   inside a table cell, rather than the boxed grid a full mutation form uses.
   Without it every row would open a 620px card in the Actions column. */
.action-form.inline {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  max-width: none; padding: 0; margin: 0 0 6px; background: none; border: 0;
}
.action-form.inline input { width: auto; min-width: 96px; flex: 0 1 auto; }
.action-form.inline input[type="number"] { min-width: 84px; }
/* The value is the only field on an inline form now, so it gets the room the
   reason box used to take — a hostname or a vault reference in a 96px input
   was a scrollable slot you could not read back. */
.action-form.inline input[name="value"] { min-width: 260px; flex: 1 1 260px; }
.action-form.inline button { padding: 4px 10px; font-size: 12px; }
.action-form label.checkbox {
  grid-template-columns: auto 1fr; align-items: center; gap: 8px; color: var(--text);
}
.action-form label.checkbox input { width: auto; }
/* Page tabs. Links, not controls — see \`tabStrip\`. Underlined rather than
   pilled so this row and the environment pills inside Variables never read as
   one flat set of choices: this one picks what the page is showing, that one
   picks whose values are shown. */
.tabs {
  display: flex; gap: 2px; flex-wrap: wrap;
  margin: 0 0 22px; border-bottom: 1px solid var(--line);
}
.tab {
  display: flex; align-items: center; gap: 7px; white-space: nowrap;
  padding: 9px 13px; color: var(--muted); font-size: 13px; font-weight: 600;
  /* Pulled onto the strip's own rule, so the active underline replaces that
     line rather than sitting a pixel below it. */
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover { color: var(--text); text-decoration: none; }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 4px 4px 0 0; }
.tab.current { color: var(--text); border-bottom-color: var(--accent); }
/* How many things are behind a tab, since a tab otherwise hides that. */
.tab-count {
  min-width: 21px; padding: 0 6px; border-radius: 999px; text-align: center;
  background: var(--panel-2); border: 1px solid var(--line);
  font-size: 11px; font-weight: 600; color: var(--muted);
}
.tab.current .tab-count { color: var(--text); }
/* How many of them are in a state someone has to do something about. Loud on
   every tab, because the alternative is an operator finding out by clicking. */
.tab-count.alert { background: var(--bad); border-color: var(--bad); color: #fff; }
.panel { margin: 0 0 24px; }
.panel > p { max-width: 78ch; }
.panel-lede { margin-top: 0; }
/* Segmented control. Server-rendered links, not controls: the panel ships no
   JavaScript, so picking an environment is a navigation. One recessed track
   with the current option raised out of it, rather than a row of loose pills
   — the options are one choice, and loose pills read as several. */
.seg {
  display: inline-flex; gap: 2px; padding: 3px; margin: 14px 0 18px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 9px;
  flex-wrap: wrap;
}
.seg-option {
  padding: 5px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;
  color: var(--muted); text-decoration: none; border: 1px solid transparent;
}
.seg-option:hover { color: var(--text); text-decoration: none; }
.seg-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.seg-option.current {
  background: var(--panel); color: var(--text);
  border-color: var(--line); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
}

/* Search, filter, and the one button that creates something, on one line.
   The button is at the far end because it is the only thing here that
   writes; everything to its left only changes what is displayed. */
.toolbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: 18px 0 12px;
}
.toolbar-search { display: flex; align-items: center; gap: 6px; flex: 1 1 320px; }
.toolbar-search input[type="search"] { flex: 1 1 200px; min-width: 160px; }
.toolbar-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
.toolbar-count { font-size: 12px; white-space: nowrap; }
/* Available to a screen reader, absent from the layout. Used for labels on
   controls a sighted operator reads from the placeholder. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* One component's keys. The heading is the namespace, because that is the
   thing that reads them. */
.var-groups { display: flex; flex-direction: column; gap: 20px; }
.var-group-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin: 0 0 8px; padding: 0 2px;
}
.var-group-head h3 {
  margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--text);
}
.var-group-head span { font-size: 12px; }
.var-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--line); border-radius: 9px; overflow: hidden;
  background: var(--panel);
}

/* A key, read at rest and edited on demand.

   A <details> per row rather than an input per row: the old table put every
   key into edit mode at once, which is a wall of form fields on a page whose
   commonest use is reading one number.

   The editor expands the row instead of floating over it. A popover would be
   clipped — any scroll container establishes one, and a confirmation card
   half-hidden behind the edge of its own list is worse than no fold. */
.var { border-bottom: 1px solid var(--line); }
.var:last-child { border-bottom: none; }
.var[open] { background: var(--panel-2); }
.var-head {
  display: grid; align-items: center; gap: 12px; padding: 11px 14px;
  grid-template-columns: minmax(180px, 1.1fr) minmax(140px, 1.4fr) auto 14px;
  cursor: pointer; list-style: none; user-select: none;
}
/* Safari draws its own disclosure triangle unless this is turned off. */
.var-head::-webkit-details-marker { display: none; }
.var-head:hover { background: var(--panel-2); }
.var-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.var-key { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.var-key code { font-size: 13px; color: var(--text); }
.var-val { min-width: 0; display: flex; align-items: center; gap: 8px; }
.var-meta { color: var(--muted); font-size: 11px; text-align: right; white-space: nowrap; }
/* The disclosure chevron, drawn rather than typed. \`\u25be\` renders as a
   4px smudge inside its em box at any size a row can afford, and its weight
   varies by platform font; two borders rotated 45 degrees are crisp
   everywhere and scale with the rule instead of with a typeface. */
.var-caret {
  width: 7px; height: 7px; justify-self: end; margin-top: -3px;
  border-right: 1.5px solid var(--muted); border-bottom: 1.5px solid var(--muted);
  transform: rotate(45deg); transition: transform 130ms ease, border-color 130ms ease;
}
.var-head:hover .var-caret { border-color: var(--text); }
.var[open] .var-caret {
  transform: rotate(225deg); margin-top: 2px; border-color: var(--text);
}

/* The value at rest. Truncated rather than wrapped: a row is one line high,
   and the full value is one click away inside the editor. */
.val {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%; font-size: 12px;
}
.val-default { color: var(--muted); }
.val-empty { color: var(--muted); font-size: 12px; font-style: italic; }
.val-missing { color: var(--bad); font-size: 12px; font-weight: 600; }
.val-tag {
  flex: none; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px;
}
/* A required key with no value is the reason someone opened this page. */
.var-alert .var-head { box-shadow: inset 3px 0 0 var(--bad); }

/* Type and flags, small enough to sit beside the key without competing. */
.chips { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.chip {
  font-size: 10px; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 4px;
  background: var(--panel-2); border: 1px solid var(--line); color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.var[open] .chip { background: var(--panel); }
.chip-req { color: var(--warn-text); border-color: var(--warn-line); }
.chip-secret { color: var(--accent); border-color: var(--accent); }
.chip-unknown { color: var(--muted); border-style: dashed; }

/* The opened editor. */
/* \`flex-end\` so the Unset button lands on Save's line rather than floating
   at the top of a form whose height depends on the field type. */
.var-body {
  display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap;
  padding: 4px 14px 16px; border-top: 1px solid var(--line);
}
.var-edit { display: grid; gap: 8px; flex: 1 1 380px; max-width: 620px; margin: 12px 0 0; }
.var-edit > label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
.var-edit input, .var-edit select, .var-edit textarea { width: 100%; }
.var-edit textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  resize: vertical;
}
.var-edit button { justify-self: start; }
/* What the schema knows, under the field it constrains. */
.field-hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
.field-hint code { font-size: 11px; color: var(--muted); }
/* On its own line: it distinguishes two actions rather than describing the
   field, and run inline after the type it reads as more schema. */
.hint-null { display: block; margin-top: 3px; }
.var-unset { margin: 12px 0 0; }
/* Destructive, and secondary to the thing the operator opened the row to do:
   outlined until hovered, never a filled red button competing with Save. */
.ghost-danger {
  background: none; color: var(--bad); border: 1px solid var(--bad-line);
  padding: 7px 14px; font-weight: 600;
}
.ghost-danger:hover { background: var(--bad); color: #fff; border-color: var(--bad); filter: none; }
/* A ritual form inside an opened row is already a bordered card; it does not
   need the row's padding on top of its own. */
.var-body .action-form { margin: 12px 0 0; flex: 1 1 380px; }

.empty-state {
  padding: 40px 20px; text-align: center; color: var(--muted);
  border: 1px dashed var(--line); border-radius: 9px; margin: 0;
}

/* Below this the four-column row is wider than the screen. The value drops
   under the key and the timestamp goes — it is the least urgent thing in
   the row, and it is repeated inside the editor. */
@media (max-width: 720px) {
  .var-head { grid-template-columns: 1fr 14px; }
  .var-val { grid-column: 1; }
  .var-meta { display: none; }
  .var-caret { grid-row: 1; grid-column: 2; align-self: start; }
}
.action-form .notice { margin-bottom: 0; }
.action-form label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); }
.action-form input { width: 100%; min-width: 0; }
.action-form button { justify-self: start; }
/* A gate folded behind the button that opens it. Same no-JavaScript
   \`<details>\` as the account menu, and the same one trade: it closes by
   clicking the trigger again, not by clicking away. */
.confirm { position: relative; display: inline-block; }
.confirm-trigger {
  display: inline-block; cursor: pointer; list-style: none; user-select: none;
  padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 600;
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
}
/* Safari draws its own disclosure triangle unless this is turned off. */
.confirm-trigger::-webkit-details-marker { display: none; }
.confirm-trigger:hover { border-color: var(--muted); }
.confirm-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
/* The one control in a toolbar that creates something, styled like the
   submit button it stands in for rather than like the neutral fold it is. */
.confirm-trigger.primary {
  background: var(--accent); color: var(--accent-ink); border-color: var(--accent);
}
.confirm-trigger.primary:hover { filter: brightness(1.08); border-color: var(--accent); }
.confirm-trigger.danger { color: var(--bad); border-color: var(--bad-line); }
.confirm-trigger.danger:hover { background: var(--bad); color: #fff; border-color: var(--bad); }
/* The form itself is the box: lifted out of flow so opening it does not shove
   the page down, and given the shadow that says it is over the page. */
.confirm .action-form {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: 20;
  width: 420px; max-width: calc(100vw - 40px); margin: 0; box-shadow: var(--shadow);
}
/* Anchored to the right edge instead where the trigger sits close enough to
   the viewport's right that a left-aligned box would run off it. */
@media (max-width: 520px) {
  .confirm .action-form { left: auto; right: 0; }
}
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
