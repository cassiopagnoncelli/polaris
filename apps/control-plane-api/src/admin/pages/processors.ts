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

import { html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { ProcessorActivationRow } from "../queries.js";
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
            <td>${mono(row.processor_name)}</td>
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
