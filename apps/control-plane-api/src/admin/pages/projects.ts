/**
 * Projects list and detail.
 *
 * The detail page is the one screen that beats the CLI outright: a project's
 * sources, destinations, and keys side by side, which otherwise takes four
 * `polaris` invocations and a mental join.
 *
 * It is tabbed, because "side by side" stopped being true. The page had grown
 * to four unrelated inventories and a mutation surface stacked in one column,
 * and the Variables panel alone renders a row per declared key across every
 * component schema — so the three tables an operator came for sat below two
 * screens of configuration they did not. Tabs put each inventory one click
 * from the heading instead of one scroll past everything else.
 *
 * Two things keep tabs from being a downgrade. They are links, so every view
 * has a URL to bookmark and paste into an incident channel — and they have to
 * be, since the panel ships no JavaScript. And the strip carries counts, so
 * hiding a table does not hide whether it is empty; anything actually broken
 * behind a tab shows as a red count on it from every other tab.
 *
 * Neither page offers create or edit. `definitions/projects/*.yaml` and
 * `definitions/sources/**` are the source of truth — Postgres holds a
 * materialised mirror that `polaris projects sync` refreshes one way. A UI
 * that wrote either would fork the source of truth against git; a UI that ran
 * `sync` would apply whatever YAML happens to be baked into this container's
 * image, silently reverting anything merged since that build. Both stay out.
 */

import { type Html, html } from "../html.js";
import {
  type AdminPageContext,
  emptyRow,
  envBadge,
  linkCard,
  mono,
  page,
  statusBadge,
  tabStrip,
  valueBadge,
} from "../layout.js";
import type { ApiKeyRow, DestinationRow, ProjectRow, SourceRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { formatInstant } from "./format.js";
import {
  type ProjectConfigPanelInput,
  renderProjectConfigPanel,
  summariseProjectConfig,
} from "./project-config.js";

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
      ? emptyRow(
          6,
          "No projects. Add one under definitions/projects/ and run `polaris projects sync`.",
        )
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

/**
 * Which view of a project is showing.
 *
 * `overview` leads because it is the only one that answers "what is this
 * project" — the other four answer "what does it have", which is a question
 * you ask second and about one thing at a time.
 */
const PROJECT_TABS = ["overview", "variables", "sources", "destinations", "keys"] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

const TAB_LABELS: Readonly<Record<ProjectTab, string>> = {
  overview: "Overview",
  variables: "Variables",
  sources: "Sources",
  destinations: "Destinations",
  keys: "API keys",
};

/**
 * Coerce the `tab` query parameter to a view.
 *
 * Falls back rather than 404s, on the same reasoning as
 * `parseConfigEnvironment`: a tab is a display affordance, and a stale
 * bookmark or a typo should land the operator on the project rather than on
 * an error page. Nothing here is a write.
 */
export function parseProjectTab(raw: string | undefined): ProjectTab {
  const candidate = (raw ?? "").trim();
  return (PROJECT_TABS as readonly string[]).includes(candidate)
    ? (candidate as ProjectTab)
    : "overview";
}

export function renderProjectDetailPage(input: {
  ctx: AdminPageContext;
  project: ProjectRow;
  sources: readonly SourceRow[];
  destinations: readonly DestinationRow[];
  apiKeys: readonly ApiKeyRow[];
  config: ProjectConfigPanelInput;
  /** Which view is showing. Defaults to the overview. */
  tab?: ProjectTab | undefined;
}): string {
  const { project } = input;
  const tab = input.tab ?? "overview";
  const projectId = encodeURIComponent(project.project_id);
  const base = `${ADMIN_PREFIX}/projects/${projectId}`;

  const variables = summariseProjectConfig(input.config.rows);
  // Not "not delivering": a paused destination is not delivering either, and
  // the destination page is careful about that distinction. This counts the
  // one state it calls an error — delivery stopped, someone stopped it.
  const stoppedDeliveries = input.destinations.filter((dest) => dest.status === "disabled").length;

  // Environment rides along on every tab link so that leaving Variables for
  // Sources and coming back does not silently drop the operator from the
  // environment they were reading into `development`.
  const href = (target: ProjectTab): string =>
    target === "overview"
      ? base
      : `${base}?tab=${target}&env=${encodeURIComponent(input.config.environment)}`;

  const tabs = tabStrip({
    label: "Project sections",
    tabs: [
      { label: TAB_LABELS.overview, href: href("overview"), current: tab === "overview" },
      {
        label: TAB_LABELS.variables,
        href: href("variables"),
        current: tab === "variables",
        count: variables.stored,
        alert: {
          count: variables.missingRequired,
          label: `${variables.missingRequired} required ${variables.missingRequired === 1 ? "key has" : "keys have"} no value in ${input.config.environment}`,
        },
      },
      {
        label: TAB_LABELS.sources,
        href: href("sources"),
        current: tab === "sources",
        count: input.sources.length,
      },
      {
        label: TAB_LABELS.destinations,
        href: href("destinations"),
        current: tab === "destinations",
        count: input.destinations.length,
        alert: {
          count: stoppedDeliveries,
          label: `${stoppedDeliveries} ${stoppedDeliveries === 1 ? "destination is" : "destinations are"} disabled — delivery is stopped`,
        },
      },
      {
        label: TAB_LABELS.keys,
        href: href("keys"),
        current: tab === "keys",
        count: input.apiKeys.length,
      },
    ],
  });

  const body = (() => {
    switch (tab) {
      case "variables":
        return renderProjectConfigPanel(input.config);
      case "sources":
        return renderSourcesTab(input.sources);
      case "destinations":
        return renderDestinationsTab(input.destinations);
      case "keys":
        return renderKeysTab(project.project_id, input.apiKeys);
      default:
        return renderOverviewTab({
          project,
          base,
          projectId,
          environment: input.config.environment,
          missingRequired: variables.missingRequired,
          stoppedDeliveries,
        });
    }
  })();

  return page({
    ctx: input.ctx,
    // The document title carries the section, so two windows open on the same
    // project's Variables and Destinations are tellable apart in the tab bar.
    // The heading does not: the strip directly below it already says which.
    title:
      tab === "overview" ? project.display_name : `${project.display_name} · ${TAB_LABELS[tab]}`,
    heading: project.display_name,
    breadcrumb: [
      { label: "Projects", href: `${ADMIN_PREFIX}/projects` },
      { label: project.project_id },
    ],
    lede: html`${statusBadge(project.status)} ${mono(project.project_id)}
      <span>owned by <strong>${project.owner}</strong></span>`,
    tabs,
    body,
  });
}

/**
 * The landing tab: what this project is, and what is wrong with it.
 *
 * The banners are the price of tabbing. A count on the strip says *that*
 * something is unset or stopped; it cannot say what to do about it, and an
 * operator who lands here and reads only this tab must still be told. They
 * link to the tab that holds the fix rather than restating it, so there is
 * one place the change is actually made.
 */
function renderOverviewTab(input: {
  project: ProjectRow;
  base: string;
  projectId: string;
  environment: string;
  missingRequired: number;
  stoppedDeliveries: number;
}): Html {
  const { project } = input;

  return html`
    ${
      input.missingRequired > 0
        ? html`<p class="notice error">
            ${String(input.missingRequired)} required
            ${input.missingRequired === 1 ? "key has" : "keys have"} no value in
            <strong>${input.environment}</strong>. Components fall back to their
            own defaults where they have one, and skip work where they do not.
            <a href="${input.base}?tab=variables&amp;env=${encodeURIComponent(input.environment)}"
              >Open Variables →</a
            >
          </p>`
        : null
    }
    ${
      input.stoppedDeliveries > 0
        ? html`<p class="notice warn">
            ${String(input.stoppedDeliveries)}
            ${input.stoppedDeliveries === 1 ? "destination is" : "destinations are"}
            disabled. Events keep flowing through the pipeline — they are not
            sent there until delivery is enabled again.
            <a href="${input.base}?tab=destinations">Open Destinations →</a>
          </p>`
        : null
    }

    <dl class="detail">
      <dt>Project id</dt>
      <dd>${mono(project.project_id)}</dd>
      <dt>Owner</dt>
      <dd>${project.owner}</dd>
      <dt>Description</dt>
      <dd>${project.description}</dd>
      <dt>Status</dt>
      <dd>${statusBadge(project.status)}</dd>
    </dl>

    <h2>Related</h2>
    <div class="linkrow">
      ${linkCard({
        href: `${ADMIN_PREFIX}/processors?project=${input.projectId}`,
        title: "Processors →",
        description: "What runs over this project's events, and where it is switched on.",
      })}
      ${linkCard({
        href: `${ADMIN_PREFIX}/dlq?project=${input.projectId}`,
        title: "Dead-letter queue →",
        description: "Messages this project's destinations gave up on, awaiting triage.",
      })}
      ${linkCard({
        href: `${ADMIN_PREFIX}/audit?project=${input.projectId}`,
        title: "Audit history →",
        description: "Every change made under this project, and who made it.",
      })}
    </div>

    <p class="provenance">
      <span>Created ${formatInstant(project.created_at)}</span>
    </p>
  `;
}

/**
 * Sources, and why there is no button to add one.
 *
 * That fact lived only in this module's doc comment, which is available to
 * whoever is editing the file and to nobody who is looking at the page and
 * wondering where the missing control went.
 */
function renderSourcesTab(sources: readonly SourceRow[]): Html {
  const rows =
    sources.length === 0
      ? emptyRow(6, "No sources declared for this project.")
      : sources.map(
          (source) => html`<tr>
            <td>${mono(source.source_id)}</td>
            <td>${valueBadge(source.source_type)}</td>
            <td>${source.owner}</td>
            <td>${source.allowed_environments.map((env) => envBadge(env))}</td>
            <td>${statusBadge(source.runtime)}</td>
            <td>${statusBadge(source.status)}</td>
          </tr>`,
        );

  return html`
    <p class="muted">
      Where this project's events come from. Declared in
      <code>definitions/sources/</code> and mirrored here by
      <code>polaris projects sync</code> — this page reads that mirror and
      never writes it, so a source is added by merging the YAML, not from a
      browser.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Type</th>
            <th>Owner</th>
            <th class="wrap">Environments</th>
            <th>Runtime</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderDestinationsTab(destinations: readonly DestinationRow[]): Html {
  const rows =
    destinations.length === 0
      ? emptyRow(6, "No destinations configured for this project.")
      : destinations.map(
          (dest) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/destinations/${encodeURIComponent(dest.destination_id)}"
                >${mono(dest.instance_label)}</a
              >
            </td>
            <td>${dest.vendor}</td>
            <td>${envBadge(dest.environment)}</td>
            <td>${statusBadge(dest.status)}</td>
            <td>${valueBadge(dest.mode)}</td>
            <td>${String(dest.max_rps)}</td>
          </tr>`,
        );

  return html`
    <p class="muted">
      Where this project's events land. Open one to see its limits, its replay
      posture, and the state changes on offer.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Instance</th>
            <th>Vendor</th>
            <th>Environment</th>
            <th>Status</th>
            <th>Mode</th>
            <th>Max RPS</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Active keys only — `listApiKeys` is called with `includeRevoked: false`.
 *
 * Said on the page rather than assumed, because a revoked key that stopped a
 * producer is exactly what someone comes here looking for, and a list that
 * silently omits it reads as "that key never existed".
 */
function renderKeysTab(projectId: string, apiKeys: readonly ApiKeyRow[]): Html {
  const rows =
    apiKeys.length === 0
      ? emptyRow(6, "No active API keys for this project.")
      : apiKeys.map(
          (key) => html`<tr>
            <td>
              <a href="${ADMIN_PREFIX}/keys/${encodeURIComponent(key.api_key_id)}"
                >${mono(key.api_key_id)}</a
              >
            </td>
            <td>${envBadge(key.environment)}</td>
            <td>${key.source_id}</td>
            <td>${valueBadge(key.source_type)}</td>
            <td>${statusBadge(key.status)}</td>
            <td>${formatInstant(key.last_used_at)}</td>
          </tr>`,
        );

  return html`
    <p class="muted">
      Active keys only.
      <a href="${ADMIN_PREFIX}/keys?project=${encodeURIComponent(projectId)}&amp;revoked=1"
        >Include revoked keys →</a
      >
    </p>
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
      >polaris keys create --project ${projectId} --env &lt;env&gt; --source
      &lt;source&gt; --type &lt;web|backend|mobile|webhook|job&gt;</code
    >
  `;
}
