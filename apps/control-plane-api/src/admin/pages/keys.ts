/**
 * API keys — metadata only.
 *
 * `api_keys.hash` is never selected by `queries.ts`, so there is nothing to
 * filter out here. Key *material* never existed outside the moment of
 * issuance: only an argon2id hash is stored.
 *
 * Issuance and rotation stay on the CLI, and this page renders the command
 * rather than a button. Show-once and a browser are incompatible: the value
 * would land in the DOM, devtools, bfcache, screenshots, and any proxy that
 * logs response bodies — and since it cannot be re-shown, a fumbled copy
 * means running `keys rotate` again, which has no grace period and would
 * break the producer a second time. A copyable command is less code and
 * keeps the UI's threat model free of plaintext secrets entirely.
 */

import { POLARIS_ENVIRONMENTS } from "@polaris/shared-environments";
import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { ApiKeyRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { checkboxField, filterForm, selectField, textField } from "./filters.js";
import { formatInstant } from "./format.js";

export interface KeyFilterValues {
  readonly project: string;
  readonly environment: string;
  readonly includeRevoked: boolean;
}

const ENVIRONMENTS = POLARIS_ENVIRONMENTS;

export function renderKeysPage(input: {
  ctx: AdminPageContext;
  keys: readonly ApiKeyRow[];
  filters: KeyFilterValues;
}): string {
  const rows =
    input.keys.length === 0
      ? emptyRow(8, "No API keys match these filters.")
      : input.keys.map(
          (key) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/keys/${encodeURIComponent(key.api_key_id)}"
                >${mono(key.api_key_id)}</a
              >
            </td>
            <td>${mono(key.project_id)}</td>
            <td>${envBadge(key.environment)}</td>
            <td>${key.source_id}</td>
            <td>${key.source_type}</td>
            <td>${statusBadge(key.status)}</td>
            <td>${formatInstant(key.created_at)}</td>
            <td>${formatInstant(key.last_used_at)}</td>
          </tr>`,
        );

  // Pre-fill from the current filters so the command is runnable as shown
  // whenever a project and environment are selected.
  const project = input.filters.project.length > 0 ? input.filters.project : "<project>";
  const environment =
    input.filters.environment.length > 0 ? input.filters.environment : "<environment>";

  return page({
    ctx: input.ctx,
    title: "API keys",
    body: html`
      ${filterForm(`${ADMIN_PREFIX}/keys`, [
        textField("project", "Project", input.filters.project),
        selectField("environment", "Environment", ENVIRONMENTS, input.filters.environment),
        checkboxField("revoked", "Include revoked", input.filters.includeRevoked),
      ])}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key id</th>
              <th>Project</th>
              <th>Environment</th>
              <th>Source</th>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>

      <h2>Issuing a key</h2>
      <p class="muted">
        Key material is shown exactly once and is unrecoverable, so it is never
        rendered in a browser. Issue keys from a terminal:
      </p>
      <code class="cli"
        >polaris keys create --project ${project} --env ${environment} --source
        &lt;source&gt; --type &lt;web|backend|mobile|webhook|job&gt;</code
      >
      <p class="muted">
        Rotation replaces a key and revokes the old one immediately, with no
        grace period — the previous key stops working the moment the
        transaction commits.
      </p>
      <code class="cli">polaris keys rotate &lt;api_key_id&gt;</code>
    `,
  });
}

export function renderKeyDetailPage(input: {
  ctx: AdminPageContext;
  apiKey: ApiKeyRow;
  actions?: Html | undefined;
}): string {
  const key = input.apiKey;
  return page({
    ctx: input.ctx,
    title: `API key · ${key.source_id}`,
    breadcrumb: [{ label: "API keys", href: `${ADMIN_PREFIX}/keys` }, { label: key.api_key_id }],
    body: html`
      <dl class="detail">
        <dt>Key id</dt>
        <dd>${mono(key.api_key_id)}</dd>
        <dt>Project</dt>
        <dd>
          <a href="${ADMIN_PREFIX}/projects/${encodeURIComponent(key.project_id)}"
            >${mono(key.project_id)}</a
          >
        </dd>
        <dt>Environment</dt>
        <dd>${envBadge(key.environment)}</dd>
        <dt>Source</dt>
        <dd>${mono(key.source_id)} <span class="muted">(${key.source_type})</span></dd>
        <dt>Status</dt>
        <dd>${statusBadge(key.status)}</dd>
        <dt>Created</dt>
        <dd>${formatInstant(key.created_at)}</dd>
        <dt>Last used</dt>
        <dd>${formatInstant(key.last_used_at)}</dd>
        <dt>Revoked</dt>
        <dd>${formatInstant(key.revoked_at)}</dd>
      </dl>
      <p class="muted">
        Key material is not stored — only an argon2id hash — so it cannot be
        shown here or anywhere else.
      </p>
      ${input.actions ?? null}
    `,
  });
}
