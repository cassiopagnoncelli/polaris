/**
 * Destinations list and detail.
 *
 * `secret_ref` is rendered because it is a `<provider>:<ref>` **pointer**, not
 * a credential — `@polaris/shared-secrets` resolves it at delivery time, and
 * the database never holds the secret itself. Showing the pointer is how an
 * operator confirms a destination is wired to the right vault entry.
 */

import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { DestinationRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { filterForm, selectField, textField } from "./filters.js";
import { formatBool, formatInstant } from "./format.js";

export interface DestinationFilterValues {
  readonly project: string;
  readonly environment: string;
  readonly status: string;
}

const ENVIRONMENTS = ["development", "staging", "production"] as const;
const STATUSES = ["active", "paused", "disabled"] as const;

export function renderDestinationsPage(input: {
  ctx: AdminPageContext;
  destinations: readonly DestinationRow[];
  filters: DestinationFilterValues;
}): string {
  const rows =
    input.destinations.length === 0
      ? emptyRow(8, "No destinations match these filters.")
      : input.destinations.map(
          (dest) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/destinations/${encodeURIComponent(dest.destination_id)}"
                >${mono(dest.instance_label)}</a
              >
            </td>
            <td>${dest.vendor}</td>
            <td>${mono(dest.project_id)}</td>
            <td>${envBadge(dest.environment)}</td>
            <td>${statusBadge(dest.status)}</td>
            <td>${dest.mode}</td>
            <td>${String(dest.max_rps)}</td>
            <td>${formatBool(dest.replay_opt_in)}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Destinations",
    body: html`
      ${filterForm(`${ADMIN_PREFIX}/destinations`, [
        textField("project", "Project", input.filters.project),
        selectField("environment", "Environment", ENVIRONMENTS, input.filters.environment),
        selectField("status", "Status", STATUSES, input.filters.status),
      ])}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instance</th>
              <th>Vendor</th>
              <th>Project</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Max RPS</th>
              <th>Replay opt-in</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `,
  });
}

export function renderDestinationDetailPage(input: {
  ctx: AdminPageContext;
  destination: DestinationRow;
  /** Mutation forms, when the viewer may run them. Empty otherwise. */
  actions?: Html | undefined;
}): string {
  const dest = input.destination;

  return page({
    ctx: input.ctx,
    title: `${dest.vendor} · ${dest.instance_label}`,
    body: html`
      <dl class="detail">
        <dt>Destination id</dt>
        <dd>${mono(dest.destination_id)}</dd>
        <dt>Project</dt>
        <dd>
          <a href="${ADMIN_PREFIX}/projects/${encodeURIComponent(dest.project_id)}"
            >${mono(dest.project_id)}</a
          >
        </dd>
        <dt>Environment</dt>
        <dd>${envBadge(dest.environment)}</dd>
        <dt>Status</dt>
        <dd>${statusBadge(dest.status)}</dd>
        <dt>Disabled reason</dt>
        <dd>${dest.disabled_reason ?? html`<span class="muted">—</span>`}</dd>
        <dt>Mode</dt>
        <dd>${dest.mode}</dd>
        <dt>Secret ref</dt>
        <dd>${mono(dest.secret_ref)} <span class="muted">(pointer, not a secret)</span></dd>
        <dt>Max concurrency</dt>
        <dd>${String(dest.max_concurrency)}</dd>
        <dt>Max RPS</dt>
        <dd>${String(dest.max_rps)}</dd>
        <dt>Retry policy</dt>
        <dd>${dest.retry_policy}</dd>
        <dt>Dead-letter threshold</dt>
        <dd>${String(dest.dead_letter_threshold)}</dd>
        <dt>Replay opt-in</dt>
        <dd>
          ${formatBool(dest.replay_opt_in)}
          ${
            dest.replay_opt_in_reason !== null
              ? html`<span class="muted"> — ${dest.replay_opt_in_reason}</span>`
              : null
          }
        </dd>
        <dt>Created</dt>
        <dd>${formatInstant(dest.created_at)}</dd>
        <dt>Updated</dt>
        <dd>${formatInstant(dest.updated_at)}</dd>
      </dl>

      <h2>Recent deliveries</h2>
      <p class="muted">
        Delivery volume and failure rates live in the Grafana
        <em>polaris-destinations</em> dashboard. Failed messages awaiting triage
        are under <a href="${ADMIN_PREFIX}/dlq?destination=${encodeURIComponent(dest.destination_id)}">DLQ</a>.
      </p>

      ${input.actions ?? null}
    `,
  });
}
