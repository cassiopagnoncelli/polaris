/**
 * Processor activations.
 *
 * `processor_activations` is per (name, version, project, environment) and is
 * the runtime on/off switch. The processor's *semantics* — inputs, outputs,
 * mode, replay support — live in `processors/<name>/v<n>/processor.manifest.yaml`
 * and in code, never in Postgres, so this page shows activation state only.
 *
 * There is no run-history table to show: `processor_runs` exists in the schema
 * but nothing populates it (the CLI's `processors runs list` is a stub pending
 * its own task), and a page that is always empty is worse than no page.
 * Throughput, lag, and failure rates are Grafana's `polaris-processors`
 * dashboard.
 */

import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { ProcessorActivationRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { formatInstant } from "./format.js";

export function renderProcessorsPage(input: {
  ctx: AdminPageContext;
  activations: readonly ProcessorActivationRow[];
}): string {
  const rows =
    input.activations.length === 0
      ? emptyRow(7, "No processor activations recorded.")
      : input.activations.map(
          (row) => html`<tr>
            <td>
              <a href="${activationHref(row)}">${mono(row.processor_name)}</a>
            </td>
            <td>${row.processor_version}</td>
            <td>${mono(row.project_id)}</td>
            <td>${envBadge(row.environment)}</td>
            <td>${statusBadge(row.enabled_state)}</td>
            <td>
              ${formatInstant(row.enabled_state === "enabled" ? row.enabled_at : row.disabled_at)}
            </td>
            <td>${row.last_changed_by}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Processors",
    body: html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Processor</th>
              <th>Version</th>
              <th>Project</th>
              <th>Environment</th>
              <th>State</th>
              <th>Changed</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin-top:16px">
        Throughput, lag, retry, and DLQ rates are in the Grafana
        <em>polaris-processors</em> dashboard. Processor semantics live in each
        processor's <code>processor.manifest.yaml</code>, not in the database.
      </p>
    `,
  });
}

/** Query-param link to one activation. The key is four fields, not a slug. */
export function activationHref(row: ProcessorActivationRow): string {
  const params = new URLSearchParams({
    name: row.processor_name,
    version: row.processor_version,
    project: row.project_id,
    environment: row.environment,
  });
  return `${ADMIN_PREFIX}/processors/activation?${params.toString()}`;
}

export function renderActivationDetailPage(input: {
  ctx: AdminPageContext;
  activation: ProcessorActivationRow;
  actions?: Html | undefined;
}): string {
  const row = input.activation;
  return page({
    ctx: input.ctx,
    title: `${row.processor_name} ${row.processor_version}`,
    body: html`
      <dl class="detail">
        <dt>Processor</dt>
        <dd>${mono(row.processor_name)}</dd>
        <dt>Version</dt>
        <dd>${row.processor_version}</dd>
        <dt>Project</dt>
        <dd>
          <a href="${ADMIN_PREFIX}/projects/${encodeURIComponent(row.project_id)}"
            >${mono(row.project_id)}</a
          >
        </dd>
        <dt>Environment</dt>
        <dd>${envBadge(row.environment)}</dd>
        <dt>State</dt>
        <dd>${statusBadge(row.enabled_state)}</dd>
        <dt>Enabled at</dt>
        <dd>${formatInstant(row.enabled_at)}</dd>
        <dt>Disabled at</dt>
        <dd>${formatInstant(row.disabled_at)}</dd>
        <dt>Last changed by</dt>
        <dd>${row.last_changed_by}</dd>
      </dl>
      <p class="muted">
        This row is the runtime on/off switch only. What the processor reads,
        emits, and how it replays live in its
        <code>processor.manifest.yaml</code> and in code — nothing here can
        change them.
      </p>
      ${input.actions ?? null}
    `,
  });
}
