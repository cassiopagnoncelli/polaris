/**
 * The landing page: counts plus the most recent audit activity.
 *
 * Deliberately not a dashboard. Grafana already owns every time series across
 * nine provisioned dashboards (ingestion, processors, destinations,
 * ClickHouse, RabbitMQ, per-project lag / skew / schema validation), and
 * redrawing any of it here would be a worse copy that drifts. What this page
 * answers is the question Grafana cannot: what control-plane objects exist
 * right now, and who changed one last.
 */

import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page } from "../layout.js";
import type { AuditRow, OverviewCounts } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { formatInstant } from "./format.js";

export function renderOverviewPage(input: {
  ctx: AdminPageContext;
  counts: OverviewCounts;
  recentAudit: readonly AuditRow[];
}): string {
  const { counts } = input;

  const stat = (label: string, value: number, href?: string): Html => {
    const body = html`<div class="n">${String(value)}</div>
      <div class="k">${label}</div>`;
    return html`<div class="card-stat">
      ${href === undefined ? body : html`<a href="${href}" style="color:inherit">${body}</a>`}
    </div>`;
  };

  const rows =
    input.recentAudit.length === 0
      ? emptyRow(5, "No audit records yet.")
      : input.recentAudit.map(
          (row) => html`<tr>
            <td>${formatInstant(row.created_at)}</td>
            <td>${row.actor_label}</td>
            <td>${mono(row.action)}</td>
            <td>${mono(row.target_id)}</td>
            <td>${envBadge(row.environment)}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Overview",
    body: html`
      <div class="cards">
        ${stat("Projects", counts.projects, `${ADMIN_PREFIX}/projects`)}
        ${stat("Sources", counts.sources, `${ADMIN_PREFIX}/projects`)}
        ${stat("Destinations active", counts.destinationsActive, `${ADMIN_PREFIX}/destinations`)}
        ${stat(
          "Destinations not active",
          counts.destinationsInactive,
          `${ADMIN_PREFIX}/destinations?status=disabled`,
        )}
        ${stat("API keys active", counts.apiKeysActive, `${ADMIN_PREFIX}/keys`)}
        ${stat("DLQ unresolved", counts.dlqUnresolved, `${ADMIN_PREFIX}/dlq`)}
      </div>

      <h2>Recent activity</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Environment</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <div class="pager">
        <a href="${ADMIN_PREFIX}/audit">All audit records →</a>
      </div>
    `,
  });
}
