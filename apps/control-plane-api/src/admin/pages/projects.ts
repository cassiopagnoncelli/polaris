/**
 * Projects list and detail.
 *
 * The detail page is the one screen that beats the CLI outright: a project's
 * sources, destinations, and keys side by side, which otherwise takes four
 * `polaris` invocations and a mental join.
 *
 * Neither page offers create or edit. `catalog/projects/*.yaml` and
 * `catalog/sources/**` are the source of truth — Postgres holds a
 * materialised mirror that `polaris projects sync` refreshes one way. A UI
 * that wrote either would fork the source of truth against git; a UI that ran
 * `sync` would apply whatever YAML happens to be baked into this container's
 * image, silently reverting anything merged since that build. Both stay out.
 */

import { html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { ApiKeyRow, DestinationRow, ProjectRow, SourceRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { formatInstant } from "./format.js";

export function renderProjectsPage(input: {
  ctx: AdminPageContext;
  projects: readonly ProjectRow[];
  sources: readonly SourceRow[];
}): string {
  const sourceCounts = new Map<string, number>();
  for (const source of input.sources) {
    sourceCounts.set(source.project_id, (sourceCounts.get(source.project_id) ?? 0) + 1);
  }

  const rows =
    input.projects.length === 0
      ? emptyRow(6, "No projects. Add one under catalog/projects/ and run `polaris projects sync`.")
      : input.projects.map(
          (project) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/projects/${encodeURIComponent(project.project_id)}"
                >${mono(project.project_id)}</a
              >
            </td>
            <td>${project.display_name}</td>
            <td>${project.owner}</td>
            <td>${String(sourceCounts.get(project.project_id) ?? 0)}</td>
            <td>${statusBadge(project.status)}</td>
            <td>${formatInstant(project.created_at)}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: "Projects",
    body: html`
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Name</th>
              <th>Owner</th>
              <th>Sources</th>
              <th>Status</th>
              <th>Created</th>
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

export function renderProjectDetailPage(input: {
  ctx: AdminPageContext;
  project: ProjectRow;
  sources: readonly SourceRow[];
  destinations: readonly DestinationRow[];
  apiKeys: readonly ApiKeyRow[];
}): string {
  const { project } = input;

  const sourceRows =
    input.sources.length === 0
      ? emptyRow(6, "No sources declared for this project.")
      : input.sources.map(
          (source) => html`<tr>
            <td>${mono(source.source_id)}</td>
            <td>${source.source_type}</td>
            <td>${source.owner}</td>
            <td>${source.allowed_environments.join(", ")}</td>
            <td>${statusBadge(source.runtime)}</td>
            <td>${statusBadge(source.status)}</td>
          </tr>`,
        );

  const destinationRows =
    input.destinations.length === 0
      ? emptyRow(5, "No destinations configured for this project.")
      : input.destinations.map(
          (dest) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/destinations/${encodeURIComponent(dest.destination_id)}"
                >${mono(dest.instance_label)}</a
              >
            </td>
            <td>${dest.vendor}</td>
            <td>${envBadge(dest.environment)}</td>
            <td>${statusBadge(dest.status)}</td>
            <td>${dest.mode}</td>
          </tr>`,
        );

  const keyRows =
    input.apiKeys.length === 0
      ? emptyRow(6, "No active API keys for this project.")
      : input.apiKeys.map(
          (key) => html`<tr>
            <td>${mono(key.api_key_id)}</td>
            <td>${envBadge(key.environment)}</td>
            <td>${key.source_id}</td>
            <td>${key.source_type}</td>
            <td>${statusBadge(key.status)}</td>
            <td>${formatInstant(key.last_used_at)}</td>
          </tr>`,
        );

  return page({
    ctx: input.ctx,
    title: project.display_name,
    body: html`
      <dl class="detail">
        <dt>Project id</dt>
        <dd>${mono(project.project_id)}</dd>
        <dt>Owner</dt>
        <dd>${project.owner}</dd>
        <dt>Description</dt>
        <dd>${project.description}</dd>
        <dt>Status</dt>
        <dd>${statusBadge(project.status)}</dd>
        <dt>Created</dt>
        <dd>${formatInstant(project.created_at)}</dd>
      </dl>

      <h2>Sources</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Type</th>
              <th>Owner</th>
              <th>Environments</th>
              <th>Runtime</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${sourceRows}
          </tbody>
        </table>
      </div>

      <h2>Destinations</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instance</th>
              <th>Vendor</th>
              <th>Environment</th>
              <th>Status</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            ${destinationRows}
          </tbody>
        </table>
      </div>

      <h2>Active API keys</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key id</th>
              <th>Environment</th>
              <th>Source</th>
              <th>Type</th>
              <th>Status</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            ${keyRows}
          </tbody>
        </table>
      </div>
    `,
  });
}
