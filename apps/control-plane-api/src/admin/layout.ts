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

export interface AdminPageContext {
  /** Environment of the *service* — what this control plane is fronting. */
  readonly environment: string;
  readonly email: string | null;
  readonly role: PlatformRoleName;
  readonly requestId: string;
  /** Path of the current page, for nav highlighting. */
  readonly path: string;
}

interface NavItem {
  readonly href: string;
  readonly label: string;
}

const NAV: ReadonlyArray<NavItem> = [
  { href: ADMIN_PREFIX, label: "Overview" },
  { href: `${ADMIN_PREFIX}/projects`, label: "Projects" },
  { href: `${ADMIN_PREFIX}/destinations`, label: "Destinations" },
  { href: `${ADMIN_PREFIX}/keys`, label: "API keys" },
  { href: `${ADMIN_PREFIX}/processors`, label: "Processors" },
  { href: `${ADMIN_PREFIX}/dlq`, label: "DLQ" },
  { href: `${ADMIN_PREFIX}/audit`, label: "Audit" },
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

/** Rendered when a filtered list comes back empty. */
export function emptyRow(columns: number, message: string): Html {
  return html`<tr>
    <td colspan="${String(columns)}" class="empty">${message}</td>
  </tr>`;
}

export interface PageInput {
  readonly ctx: AdminPageContext;
  readonly title: string;
  readonly body: Html;
}

/** Full HTML document. */
export function page(input: PageInput): string {
  const { ctx } = input;
  const nav = NAV.map((item) => {
    const current =
      item.href === ADMIN_PREFIX ? ctx.path === ADMIN_PREFIX : ctx.path.startsWith(item.href);
    return html`<a href="${item.href}" class="${current ? "nav-link current" : "nav-link"}"
      >${item.label}</a
    >`;
  });

  return render(html`<!doctype html>
<html lang="en">
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
      </div>
      <div class="topbar-right">
        <span class="who">${ctx.email ?? "signed in"}</span>
        <span class="badge badge-muted">${ctx.role}</span>
        <form method="post" action="${AUTH_PREFIX}/logout" class="inline">
          <button type="submit" class="link-button">Sign out</button>
        </form>
      </div>
    </header>
    <nav class="nav">${nav}</nav>
    <main>
      <h1>${input.title}</h1>
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

/** Standalone page for the pre-session routes (login, forbidden, signed out). */
export function barePage(title: string, body: Html): string {
  return render(html`<!doctype html>
<html lang="en">
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

export const STYLESHEET = raw(`
:root {
  --bg: #0f1115;
  --panel: #161a21;
  --panel-2: #1c212a;
  --line: #272d38;
  --text: #dfe3ea;
  --muted: #8b94a4;
  --accent: #5b9dff;
  --ok: #3fb950;
  --bad: #f85149;
  --prod: #d1242f;
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
.topbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 10px 20px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
.topbar-left, .topbar-right { display: flex; align-items: center; gap: 10px; }
.brand { font-weight: 700; letter-spacing: 0.02em; color: var(--text); }
.brand-lg { font-size: 20px; margin-bottom: 12px; }
.who { color: var(--muted); }
.nav {
  display: flex; gap: 4px; flex-wrap: wrap;
  padding: 8px 20px; background: var(--panel-2); border-bottom: 1px solid var(--line);
}
.nav-link { padding: 5px 10px; border-radius: 6px; color: var(--muted); }
.nav-link:hover { background: var(--panel); color: var(--text); text-decoration: none; }
.nav-link.current { background: var(--panel); color: var(--text); }
main { padding: 22px 20px 40px; max-width: 1400px; }
h1 { font-size: 20px; margin: 0 0 18px; font-weight: 650; }
h2 { font-size: 15px; margin: 26px 0 10px; font-weight: 650; color: var(--muted);
     text-transform: uppercase; letter-spacing: 0.06em; }
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
.badge-ok { color: var(--ok); border-color: #23502c; }
.badge-bad { color: var(--bad); border-color: #5c2321; }
.badge-muted { color: var(--muted); }
.muted { color: var(--muted); }
.cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.card-stat {
  flex: 1 1 150px; padding: 14px 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 8px;
}
.card-stat .n { font-size: 26px; font-weight: 650; }
.card-stat .k { color: var(--muted); font-size: 12px; text-transform: uppercase;
                letter-spacing: 0.05em; }
form.filters {
  display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 14px;
}
form.filters label { display: flex; flex-direction: column; gap: 4px;
                     font-size: 12px; color: var(--muted); }
input, select, textarea {
  background: var(--panel-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px;
  font: inherit; min-width: 150px;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  background: var(--accent); color: #08111f; border: 0; border-radius: 6px;
  padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer;
}
button:hover { filter: brightness(1.08); }
button.secondary { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
button.danger { background: var(--bad); color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.link-button { background: none; color: var(--muted); padding: 4px 6px; font-weight: 500; }
.link-button:hover { color: var(--text); filter: none; text-decoration: underline; }
form.inline { display: inline; }
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
pre {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 6px;
  padding: 12px; overflow-x: auto; font-size: 12px; margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.notice { padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line);
          background: var(--panel); margin-bottom: 16px; }
.notice.error { border-color: #5c2321; color: #ffb4ae; }
.notice.warn { border-color: #5c4a21; color: #ffd9a0; }
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
