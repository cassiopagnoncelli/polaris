/**
 * Destination DLQ — metadata only.
 *
 * The `payload` column is never fetched (see `queries.ts`), so it cannot be
 * rendered here even by accident. It holds the raw event envelope, which is
 * the one thing on these pages an external party controls, and which carries
 * producer-supplied fields like `context.page.url` plus whatever identity and
 * context the event was born with.
 *
 * Note that "just run it through @polaris/shared-policy first" would not fix
 * that: the ingester already applies `evaluate()` + `applyRedactions()`
 * *before* publishing, so a DLQ payload is the post-redaction envelope.
 * Re-running the same evaluator finds nothing by construction, and the
 * "redacted" badge it would justify would be false — the residual
 * `identity.customer_id`, `context.ip`, `page.url` are exactly what the policy
 * permits by design. Operators who need the bytes have `polaris dlq show`.
 */

import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { DlqRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { checkboxField, filterForm, textField } from "./filters.js";
import { formatInstant } from "./format.js";

export interface DlqFilterValues {
  readonly destination: string;
  readonly vendor: string;
  readonly includeResolved: boolean;
}

export function renderDlqPage(input: {
  ctx: AdminPageContext;
  records: readonly DlqRow[];
  filters: DlqFilterValues;
  limit: number;
}): string {
  const rows =
    input.records.length === 0
      ? emptyRow(8, "No DLQ records match these filters.")
      : input.records.map(
          (row) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/dlq/${encodeURIComponent(row.dlq_id)}">${mono(row.dlq_id)}</a>
            </td>
            <td>${row.vendor}</td>
            <td>${mono(row.project_id)}</td>
            <td>${envBadge(row.environment)}</td>
            <td>${row.reason}</td>
            <td>${row.error_class ?? html`<span class="muted">—</span>`}</td>
            <td>${String(row.attempts)}</td>
            <td>
              ${
                row.resolved_at === null
                  ? statusBadge("unresolved")
                  : html`${statusBadge("resolved")}
                  <span class="muted">${row.resolved_by ?? ""}</span>`
              }
            </td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Destination DLQ",
    body: html`
      ${filterForm(`${ADMIN_PREFIX}/dlq`, [
        textField("destination", "Destination id", input.filters.destination),
        textField("vendor", "Vendor", input.filters.vendor),
        checkboxField("resolved", "Include resolved", input.filters.includeResolved),
      ])}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>DLQ id</th>
              <th>Vendor</th>
              <th>Project</th>
              <th>Environment</th>
              <th>Reason</th>
              <th>Error class</th>
              <th>Attempts</th>
              <th>State</th>
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

export function renderDlqDetailPage(input: {
  ctx: AdminPageContext;
  record: DlqRow;
  actions?: Html | undefined;
}): string {
  const row = input.record;

  return page({
    ctx: input.ctx,
    title: `DLQ · ${row.reason}`,
    body: html`
      <dl class="detail">
        <dt>DLQ id</dt>
        <dd>${mono(row.dlq_id)}</dd>
        <dt>Destination</dt>
        <dd>
          <a href="${ADMIN_PREFIX}/destinations/${encodeURIComponent(row.destination_id)}"
            >${mono(row.destination_id)}</a
          >
        </dd>
        <dt>Vendor</dt>
        <dd>${row.vendor}</dd>
        <dt>Project</dt>
        <dd>${mono(row.project_id)}</dd>
        <dt>Environment</dt>
        <dd>${envBadge(row.environment)}</dd>
        <dt>Event id</dt>
        <dd>${mono(row.event_id)}</dd>
        <dt>Reason</dt>
        <dd>${row.reason}</dd>
        <dt>Error class</dt>
        <dd>${row.error_class ?? html`<span class="muted">—</span>`}</dd>
        <dt>Attempts</dt>
        <dd>${String(row.attempts)}</dd>
        <dt>Created</dt>
        <dd>${formatInstant(row.created_at)}</dd>
        <dt>Resolved</dt>
        <dd>
          ${
            row.resolved_at === null
              ? html`<span class="muted">unresolved</span>`
              : html`${formatInstant(row.resolved_at)} by ${row.resolved_by ?? "—"}`
          }
        </dd>
      </dl>

      <h2>Payload</h2>
      <p class="muted">
        Not shown. The stored envelope is producer-controlled and carries
        identity and page context; this panel deliberately holds no view of it.
        Inspect it from a terminal, where the output is not a web page:
      </p>
      <code class="cli">polaris dlq show ${row.dlq_id}</code>

      <h2>Retry</h2>
      <p class="muted">
        Retrying republishes the stored envelope to the vendor's redelivery
        queue — a real delivery to a real vendor, with real end-user effects.
        That belongs on a terminal too:
      </p>
      <code class="cli">polaris dlq retry ${row.dlq_id} --note "&lt;why&gt;"</code>

      ${input.actions ?? null}
    `,
  });
}
