/**
 * Audit list and detail.
 *
 * This is the highest-value read surface in the panel: cross-referencing who
 * changed what, when, and why is painful in a terminal and trivial in a
 * table. Rows written by the CLI and by this UI share one stream — same
 * `action` strings, distinguished by `actor_label` (an operator email for UI
 * writes, an operator-token label or `cli` for terminal ones).
 *
 * `before` / `after` are jsonb snapshots of operational state, and by the
 * schema's own contract they never carry secrets. They still render inside a
 * `<pre>` as escaped text, never as markup.
 */

import { formatJson, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page } from "../layout.js";
import type { AuditRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { filterForm, selectField, textField } from "./filters.js";
import { formatInstant } from "./format.js";

export interface AuditFilterValues {
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly project: string;
  readonly environment: string;
}

const ENVIRONMENTS = ["development", "staging", "production"] as const;

export function renderAuditPage(input: {
  ctx: AdminPageContext;
  records: readonly AuditRow[];
  filters: AuditFilterValues;
  limit: number;
}): string {
  const rows =
    input.records.length === 0
      ? emptyRow(7, "No audit records match these filters.")
      : input.records.map(
          (row) => html`<tr>
            <td>${formatInstant(row.created_at)}</td>
            <td>${row.actor_label}</td>
            <td>${row.actor_source}</td>
            <td>${mono(row.action)}</td>
            <td>${mono(row.target_id)}</td>
            <td>${envBadge(row.environment)}</td>
            <td>
              <a href="${ADMIN_PREFIX}/audit/${encodeURIComponent(row.audit_id)}">details</a>
            </td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Audit",
    body: html`
      ${filterForm(`${ADMIN_PREFIX}/audit`, [
        textField("actor", "Actor", input.filters.actor),
        textField("action", "Action", input.filters.action),
        textField("target_type", "Target type", input.filters.targetType),
        textField("target_id", "Target id", input.filters.targetId),
        textField("project", "Project", input.filters.project),
        selectField("environment", "Environment", ENVIRONMENTS, input.filters.environment),
      ])}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Source</th>
              <th>Action</th>
              <th>Target</th>
              <th>Environment</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span class="muted">Showing up to ${String(input.limit)} most recent records.</span>
      </div>
    `,
  });
}

export function renderAuditDetailPage(input: { ctx: AdminPageContext; record: AuditRow }): string {
  const record = input.record;
  const before = formatJson(record.before);
  const after = formatJson(record.after);

  return page({
    ctx: input.ctx,
    title: record.action,
    breadcrumb: [
      { label: "Audit", href: `${ADMIN_PREFIX}/audit` },
      { label: record.audit_id },
    ],
    body: html`
      <dl class="detail">
        <dt>Audit id</dt>
        <dd>${mono(record.audit_id)}</dd>
        <dt>When</dt>
        <dd>${formatInstant(record.created_at)}</dd>
        <dt>Actor</dt>
        <dd>${record.actor_label} <span class="muted">(${record.actor_source})</span></dd>
        <dt>Action</dt>
        <dd>${mono(record.action)}</dd>
        <dt>Target</dt>
        <dd>${mono(record.target_type)} ${mono(record.target_id)}</dd>
        <dt>Project</dt>
        <dd>${record.project_id ?? html`<span class="muted">—</span>`}</dd>
        <dt>Environment</dt>
        <dd>${envBadge(record.environment)}</dd>
        <dt>Reason</dt>
        <dd>${record.reason ?? html`<span class="muted">—</span>`}</dd>
        <dt>Request id</dt>
        <dd>${mono(record.request_id)}</dd>
      </dl>

      <h2>Before</h2>
      <pre>${before.length > 0 ? before : "—"}</pre>

      <h2>After</h2>
      <pre>${after.length > 0 ? after : "—"}</pre>
    `,
  });
}
