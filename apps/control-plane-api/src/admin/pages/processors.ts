/**
 * Processors: operator intent beside runtime reality.
 *
 * Two tables, because they answer two different questions and a single one
 * would blur them:
 *
 *   - `processor_activations` — per (name, version, project, environment),
 *     what an operator has switched ON. Intent.
 *   - `processor_runs` — what actually started, on which host, since when.
 *     Reality, written by each processor's boot layer through
 *     `@polaris/shared-processor`'s `openProcessorRun`.
 *
 * The two disagreeing is the interesting case. A `disabled` row now stops the
 * named processor for that (project, environment) within seconds — the
 * runtime gate reads this table — so a row that says `disabled` next to a
 * `running` process means the run is still up but skipping that project's
 * events, which is exactly what an operator needs to see. Absence of a row
 * means allowed; only an explicit disable stops anything.
 *
 * Neither table carries processor *semantics* — inputs, outputs, mode, replay
 * support live in `processors/<name>/v<n>/processor.manifest.yaml` and in
 * code, never in Postgres. Throughput, lag, and failure rates are Grafana's
 * `polaris-processors` dashboard; the counters here are per-run totals for
 * triage, not a metrics surface.
 */

import { POLARIS_ENVIRONMENTS, rowEnvironmentFor } from "@polaris/shared-environments";
import { type Html, html } from "../html.js";
import {
  type AdminPageContext,
  emptyRow,
  envBadge,
  mono,
  page,
  statusBadge,
  tabStrip,
} from "../layout.js";
import type { ProcessorActivationRow, ProcessorRunRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { filterForm, selectField } from "./filters.js";
import { formatInstant } from "./format.js";

/**
 * Sentence shown when no operator has activated anything yet.
 *
 * A fresh install lands here, and "no rows" on its own reads as a broken
 * page. Name what the table holds and the one command that puts something
 * in it — processors that exist but were never activated are simply absent.
 */
const NO_ACTIVATIONS =
  "Nothing to activate yet — no processor has started and no project " +
  "exists, so there is no (processor, version, project, environment) " +
  "combination to decide about. A row appears here as soon as a processor " +
  "boots or an activation is recorded.";

/**
 * Effective activation state for one combination.
 *
 * `default_enabled` is the case this table exists to stop hiding. The
 * runtime gate lets an event through unless an explicit `disabled` row
 * says otherwise (see `@polaris/shared-processor`'s activation gate), so
 * a combination with no row is RUNNING. The previous version of this page
 * listed only the rows that existed and explained the rule in a footnote,
 * which left the operator to infer the state of everything absent —
 * exactly backwards, since the absent combinations are the ones running
 * without anyone having decided they should.
 */
type EffectiveState = "enabled" | "disabled" | "default_enabled";

/**
 * Environments a combination can exist in. Matches the closed set the
 * keys / audit / destinations pages already declare; exported here
 * because the route needs the same list to build the matrix.
 */
export const ACTIVATION_ENVIRONMENTS = POLARIS_ENVIRONMENTS;

/**
 * Most combinations this page will render at once.
 *
 * Chosen to keep the page readable rather than to protect the query —
 * the data is already in memory. When it trips, the page says how many
 * rows it left out; see the note where it is applied.
 */
export const ACTIVATION_MATRIX_LIMIT = 500;

interface ActivationCell {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly state: EffectiveState;
  readonly changed_at: Date | null;
  readonly last_changed_by: string | null;
}

/**
 * Build one cell per (processor version × project × environment).
 *
 * Processor versions come from what the control plane has seen — existing
 * activations plus recorded runs — rather than from a filesystem walk of
 * `processors/`, which the API does not have. A version that has never
 * booted and never been activated is genuinely unknown here, and inventing
 * a row for it would be a guess of a different kind.
 */
export function buildActivationMatrix(input: {
  activations: readonly ProcessorActivationRow[];
  runs: readonly ProcessorRunRow[];
  projects: readonly string[];
  environments: readonly string[];
}): readonly ActivationCell[] {
  const versions = new Map<string, { name: string; version: string }>();
  for (const row of input.activations) {
    versions.set(`${row.processor_name}:${row.processor_version}`, {
      name: row.processor_name,
      version: row.processor_version,
    });
  }
  for (const row of input.runs) {
    versions.set(`${row.processor_name}:${row.processor_version}`, {
      name: row.processor_name,
      version: row.processor_version,
    });
  }

  const explicit = new Map<string, ProcessorActivationRow>();
  for (const row of input.activations) {
    explicit.set(
      `${row.processor_name}:${row.processor_version}:${row.project_id}:${row.environment}`,
      row,
    );
  }

  const cells: ActivationCell[] = [];
  for (const { name, version } of [...versions.values()].sort((a, b) =>
    `${a.name}${a.version}`.localeCompare(`${b.name}${b.version}`),
  )) {
    for (const project of [...input.projects].sort()) {
      for (const environment of input.environments) {
        const row = explicit.get(`${name}:${version}:${project}:${environment}`);
        if (row === undefined) {
          cells.push({
            processor_name: name,
            processor_version: version,
            project_id: project,
            environment,
            state: "default_enabled",
            changed_at: null,
            last_changed_by: null,
          });
          continue;
        }
        cells.push({
          processor_name: name,
          processor_version: version,
          project_id: project,
          environment,
          state: row.enabled_state === "disabled" ? "disabled" : "enabled",
          changed_at: row.enabled_state === "enabled" ? row.enabled_at : row.disabled_at,
          last_changed_by: row.last_changed_by,
        });
      }
    }
  }
  return cells;
}

const NO_RUNS =
  "No processor has started since run recording landed. A row appears here " +
  "when a processor boots and reaches PostgreSQL.";

/**
 * Which of the two questions the page is answering.
 *
 * Intent and reality were stacked in one column, so reading "what is
 * switched off" meant scrolling past a matrix that is versions x projects x
 * environments — capped at 500 rows precisely because it gets that big. They
 * are separate questions asked at separate times, which is what a tab is
 * for. `activations` leads because it is the one an operator can act on.
 */
const PROCESSOR_TABS = ["activations", "runs"] as const;

export type ProcessorTab = (typeof PROCESSOR_TABS)[number];

const PROCESSOR_TAB_LABELS: Readonly<Record<ProcessorTab, string>> = {
  activations: "Activations",
  runs: "Recent runs",
};

/** Falls back rather than 404s — a tab is a display affordance, not a write. */
export function parseProcessorTab(raw: string | undefined): ProcessorTab {
  const candidate = (raw ?? "").trim();
  return (PROCESSOR_TABS as readonly string[]).includes(candidate)
    ? (candidate as ProcessorTab)
    : "activations";
}

/**
 * The state axis, as an operator would name it rather than as it is stored.
 *
 * `enabled` means EFFECTIVELY enabled — an explicit `enabled` row and a
 * combination nobody has decided about are both running, and the gate only
 * closes on an explicit disable. An earlier revision had it mean "explicitly
 * enabled" on the reasoning that somebody filtering for it wants decisions
 * that were made. That was defensible while it was something you opted into
 * and wrong the moment it became the default view: on an install where
 * nothing has been decided, every combination is a default, and the page
 * would have opened on an empty table reading as "no processors".
 *
 * `default` stays as its own option because "what has nobody decided about?"
 * is a real question. It is a subset of `enabled`, not a peer of it, and the
 * label says so.
 */
export const ACTIVATION_STATES = ["enabled", "disabled", "default"] as const;

const STATE_LABELS: Readonly<Record<string, string>> = {
  enabled: "Enabled (running)",
  disabled: "Disabled",
  default: "No decision recorded",
};

/** Statuses a run row can carry, for the runs filter. */
export const RUN_STATUSES = ["running", "completed", "failed"] as const;

/**
 * Filter values the processors page reads from the query string.
 *
 * `processor` and `state` are the two that were missing, and they are the
 * two an incident actually asks for: "what is switched off" and "show me
 * this one processor". Without them the only way to answer either was to
 * read 500 rows.
 */
export interface ProcessorFilterValues {
  readonly processor: string;
  readonly project: string;
  readonly environment: string;
  /** "", "enabled", "disabled", or "default". */
  readonly state: string;
  /** Runs tab only: "", "running", "completed", "failed". */
  readonly status: string;
}

/**
 * Narrow the matrix before the cap applies.
 *
 * Order matters: filtering after capping would show "500 of 1800" and then
 * hide most of what the operator filtered FOR. Filtering first means a
 * scoped view is complete, which is the whole reason the filter exists —
 * a large install cannot see its own matrix otherwise.
 */
export function applyActivationFilters(
  cells: readonly ActivationCell[],
  filters: ProcessorFilterValues,
): readonly ActivationCell[] {
  return cells.filter((cell) => {
    if (filters.processor.length > 0 && cell.processor_name !== filters.processor) return false;
    if (filters.project.length > 0 && cell.project_id !== filters.project) return false;
    if (filters.environment.length > 0 && cell.environment !== filters.environment) return false;
    if (filters.state.length > 0) {
      // `enabled` is the effective state, so it matches the undecided
      // combinations too — see ACTIVATION_STATES. `default` narrows to just
      // those.
      const matches =
        filters.state === "enabled"
          ? cell.state === "enabled" || cell.state === "default_enabled"
          : filters.state === "default"
            ? cell.state === "default_enabled"
            : cell.state === filters.state;
      if (!matches) return false;
    }
    return true;
  });
}

/** The same, for the runs tab. */
export function applyRunFilters(
  runs: readonly ProcessorRunRow[],
  filters: ProcessorFilterValues,
): readonly ProcessorRunRow[] {
  return runs.filter((run) => {
    if (filters.processor.length > 0 && run.processor_name !== filters.processor) return false;
    // A run's environment is nullable — a cross-project run records none.
    // Filtering by environment must therefore drop it rather than match it,
    // or "development" would silently include runs of unknown environment.
    if (filters.environment.length > 0 && run.environment !== filters.environment) return false;
    if (filters.status.length > 0 && run.status !== filters.status) return false;
    return true;
  });
}

/**
 * What the page shows before anyone has filtered anything.
 *
 * The unfiltered matrix is versions x projects x environments and is capped
 * at 500 rows, so "no filter" was never a useful landing state — it opened on
 * a wall of combinations that are running because nobody has said otherwise.
 * The default view answers the question an operator actually arrives with:
 * what is on, here, now.
 *
 *   - **project** — the only project, when there is exactly one. Polaris is
 *     multi-project by design, so there is no notion of a main one; with
 *     several, picking any of them would be a guess and the filter stays
 *     open.
 *   - **environment** — the one this deployment fronts. `POLARIS_ENV` is a
 *     deployment environment and `local` is not a row value, so the
 *     translation goes through `rowEnvironmentFor` rather than a `=== "local"`
 *     check written here.
 *   - **state** — enabled, meaning actually running. What is switched off is
 *     one select away and is counted on the tab from either side.
 *
 * Run status is deliberately not defaulted. `completed` and `failed` runs are
 * the history the tab exists to show, and hiding them behind a default would
 * make the failure count on the tab point at rows the operator cannot see.
 */
export function defaultProcessorFilters(input: {
  projects: readonly string[];
  serviceEnvironment: string;
}): ProcessorFilterValues {
  return {
    processor: "",
    project: input.projects.length === 1 ? (input.projects[0] ?? "") : "",
    environment: rowEnvironmentFor(input.serviceEnvironment),
    state: "enabled",
    status: "",
  };
}

/** Whether any of these filters is doing something. */
function isFiltered(filters: ProcessorFilterValues): boolean {
  return (
    filters.processor.length > 0 ||
    filters.project.length > 0 ||
    filters.environment.length > 0 ||
    filters.state.length > 0 ||
    filters.status.length > 0
  );
}

/** The query string these filters correspond to, for a tab or a reset link. */
function filterQuery(filters: ProcessorFilterValues, tab: ProcessorTab): string {
  const params = new URLSearchParams();
  if (tab !== "activations") params.set("tab", tab);
  // Every key is emitted once any is set, so the URL says "these are my
  // filters" rather than "these plus whatever the defaults are" — which is
  // also how the route tells a deliberate `any` from an unvisited page.
  if (isFiltered(filters)) {
    params.set("name", filters.processor);
    params.set("project", filters.project);
    params.set("environment", filters.environment);
    if (tab === "runs") params.set("status", filters.status);
    else params.set("state", filters.state);
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

/** Every processor name the control plane has seen, for the filter menu. */
function knownProcessors(
  activations: readonly ProcessorActivationRow[],
  runs: readonly ProcessorRunRow[],
): readonly string[] {
  const names = new Set<string>();
  for (const row of activations) names.add(row.processor_name);
  for (const row of runs) names.add(row.processor_name);
  return [...names].sort();
}

export function renderProcessorsPage(input: {
  ctx: AdminPageContext;
  activations: readonly ProcessorActivationRow[];
  runs: readonly ProcessorRunRow[];
  projects: readonly string[];
  environments: readonly string[];
  filters: ProcessorFilterValues;
  tab?: ProcessorTab | undefined;
  /**
   * True when `filters` came from `defaultProcessorFilters` rather than from
   * the operator. Only the route knows whether it happened; only the page
   * knows to say so.
   */
  defaulted?: boolean | undefined;
}): string {
  const tab = input.tab ?? "activations";
  const base = `${ADMIN_PREFIX}/processors`;

  const allCells = buildActivationMatrix({
    activations: input.activations,
    runs: input.runs,
    projects: input.projects,
    environments: input.environments,
  });

  // Counted over everything, never over what survived the filter: a tab
  // badge that moves when you change a select is not telling you how much
  // there is, and the disabled count in particular has to mean the same
  // thing from either tab.
  const disabled = allCells.filter((cell) => cell.state === "disabled").length;
  const failed = input.runs.filter((run) => run.status === "failed").length;

  // Filters ride along, so moving between intent and reality keeps the scope
  // the operator set. Without this, switching tabs silently widened the view
  // back to everything — and, once defaults existed, back to the defaults.
  const href = (target: ProcessorTab): string => `${base}${filterQuery(input.filters, target)}`;

  const tabs = tabStrip({
    label: "Processor views",
    tabs: [
      {
        label: PROCESSOR_TAB_LABELS.activations,
        href: href("activations"),
        current: tab === "activations",
        count: allCells.length,
        alert: {
          count: disabled,
          label: `${disabled} ${disabled === 1 ? "combination is" : "combinations are"} explicitly disabled`,
        },
      },
      {
        label: PROCESSOR_TAB_LABELS.runs,
        href: href("runs"),
        current: tab === "runs",
        count: input.runs.length,
        alert: {
          count: failed,
          label: `${failed} ${failed === 1 ? "run" : "runs"} failed`,
        },
      },
    ],
  });

  return page({
    ctx: input.ctx,
    title: tab === "activations" ? "Processors" : "Processors · Recent runs",
    heading: "Processors",
    lede: html`Operator intent, and what is actually running.`,
    tabs,
    body:
      tab === "runs"
        ? renderRunsTab(input, base)
        : renderActivationsTab({ ...input, defaulted: input.defaulted === true }, base, allCells),
  });
}

/**
 * Intent: every combination and the state somebody did or did not choose.
 *
 * The explanation of what the three states mean stays on this tab rather
 * than above the strip. It is only true of this table, and a page-level
 * paragraph that describes one of two tabs is read on the wrong one.
 */
function renderActivationsTab(
  input: {
    activations: readonly ProcessorActivationRow[];
    runs: readonly ProcessorRunRow[];
    filters: ProcessorFilterValues;
    defaulted: boolean;
  },
  base: string,
  allCells: readonly ActivationCell[],
): Html {
  const running = countRunningByProcessor(input.runs);
  const cells = applyActivationFilters(allCells, input.filters);

  // The matrix is versions x projects x environments, so it grows fast:
  // 6 processors at 2 versions across 50 projects is 1800 rows. Cap it and
  // SAY the cap — a page that silently shows the first N reads as "this is
  // everything", which is the failure this whole change exists to stop.
  // Explicit decisions sort first so a truncation drops defaults, never a
  // decision somebody made.
  const ordered = [...cells].sort((a, b) => {
    const aExplicit = a.state === "default_enabled" ? 1 : 0;
    const bExplicit = b.state === "default_enabled" ? 1 : 0;
    return aExplicit - bExplicit;
  });
  const shown = ordered.slice(0, ACTIVATION_MATRIX_LIMIT);
  const omitted = ordered.length - shown.length;

  const rows =
    cells.length === 0
      ? emptyRow(
          8,
          allCells.length === 0 ? NO_ACTIVATIONS : "No combination matches these filters.",
        )
      : shown.map(
          (row) => html`<tr>
            <td>
              <a href="${activationHref(row)}">${mono(row.processor_name)}</a>
            </td>
            <td>${row.processor_version}</td>
            <td>${mono(row.project_id)}</td>
            <td>${envBadge(row.environment)}</td>
            <td>${activationStateBadge(row.state)}</td>
            <td>${runningCell(running.get(processorKey(row)) ?? 0)}</td>
            <td>${formatInstant(row.changed_at)}</td>
            <td>${row.last_changed_by ?? "—"}</td>
          </tr>`,
        );

  return html`
    <p class="muted prose">
      Every (processor, version, project, environment) combination has a state
      here, whether or not anyone has decided one.
      <strong>enabled (default)</strong> means no activation row exists — which
      is RUNNING, because the gate only closes on an explicit disable. A
      <strong>disabled</strong> row stops that processor from acting on that
      project's events, within about ten seconds. <strong>Running</strong> is
      the process itself: a disabled scope still shows as running, because the
      process stays up and skips those events rather than exiting.
    </p>

    ${filterForm(base, [
      selectField(
        "name",
        "Processor",
        knownProcessors(input.activations, input.runs),
        input.filters.processor,
        "any processor",
      ),
      selectField(
        "project",
        "Project",
        projectOptions(allCells),
        input.filters.project,
        "any project",
      ),
      selectField(
        "environment",
        "Environment",
        ACTIVATION_ENVIRONMENTS,
        input.filters.environment,
        "any environment",
      ),
      labelledSelect("state", "State", ACTIVATION_STATES, input.filters.state, "any state"),
    ])}

    ${
      omitted > 0
        ? html`<p class="notice">
            Showing ${String(shown.length)} of ${String(ordered.length)}
            combinations — ${String(omitted)} omitted. Every explicit decision
            is shown; the omitted rows are all
            <strong>enabled (default)</strong>. Narrow the filters above to see
            them.
          </p>`
        : null
    }
    ${defaultViewNotice(input, base)}
    ${countLine(cells.length, allCells.length, "combination", "combinations")}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Processor</th>
            <th>Version</th>
            <th>Project</th>
            <th>Environment</th>
            <th>State</th>
            <th>Running</th>
            <th>Changed</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

/** Reality: what started, where, and how it went. */
function renderRunsTab(
  input: {
    activations: readonly ProcessorActivationRow[];
    runs: readonly ProcessorRunRow[];
    filters: ProcessorFilterValues;
  },
  base: string,
): Html {
  const runs = applyRunFilters(input.runs, input.filters);

  const rows =
    runs.length === 0
      ? emptyRow(9, input.runs.length === 0 ? NO_RUNS : "No run matches these filters.")
      : runs.map(
          (row) => html`<tr>
            <td>${mono(row.run_id)}</td>
            <td>${mono(row.processor_name)}</td>
            <td>${row.processor_version}</td>
            <td>${envBadge(row.environment)}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${formatInstant(row.started_at)}</td>
            <td>${formatInstant(row.finished_at)}</td>
            <td>
              ${String(row.events_consumed)} / ${String(row.events_emitted)} /
              ${String(row.events_failed)}
            </td>
            <td>${mono(row.host)}</td>
          </tr>`,
        );

  return html`
    <p class="muted prose">
      What actually started, on which host, since when — written by each
      processor's boot layer, not by an operator. A run stays
      <em>running</em> while the process is up, whatever any activation says
      about it.
    </p>

    ${filterForm(
      base,
      [
        selectField(
          "name",
          "Processor",
          knownProcessors(input.activations, input.runs),
          input.filters.processor,
          "any processor",
        ),
        selectField(
          "environment",
          "Environment",
          ACTIVATION_ENVIRONMENTS,
          input.filters.environment,
          "any environment",
        ),
        selectField("status", "Status", RUN_STATUSES, input.filters.status, "any status"),
      ],
      { tab: "runs" },
    )}
    ${countLine(runs.length, input.runs.length, "run", "runs")}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Processor</th>
            <th>Version</th>
            <th>Environment</th>
            <th>Status</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Consumed / emitted / failed</th>
            <th>Host</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <p class="muted prose">
      Per-run counters are running totals for that process, flushed every 15
      seconds, so a <em>running</em> row can trail reality by about that long.
      They are triage context beside a run, not a metrics surface —
      throughput, lag, retry, and DLQ <em>rates</em> are in the Grafana
      <em>polaris-processors</em> dashboard. Processor semantics live in each
      processor's <code>processor.manifest.yaml</code>, not in the database.
    </p>
  `;
}

/**
 * "12 of 240" — rendered only when a filter is actually hiding something.
 *
 * A filtered table and an empty one look identical once the controls have
 * scrolled off, and the difference matters: one means "nothing here", the
 * other means "nothing here that you asked for".
 */
function countLine(shown: number, total: number, one: string, many: string): Html | null {
  if (shown === total) return null;
  return html`<p class="muted filter-count">
    ${String(shown)} of ${String(total)} ${total === 1 ? one : many}
  </p>`;
}

/**
 * A select whose option text differs from its value.
 *
 * `enabled` as a bare word does not say whether it includes the combinations
 * nobody decided about, and that is the one thing about this filter worth
 * saying — so the menu says "Enabled (running)" and submits `enabled`.
 */
function labelledSelect(
  name: string,
  label: string,
  options: readonly string[],
  selected: string,
  anyLabel: string,
): Html {
  return html`<label>
    <span>${label}</span>
    <select name="${name}">
      <option value="">${anyLabel}</option>
      ${options.map(
        (option) =>
          html`<option value="${option}" ${option === selected ? "selected" : ""}>
            ${STATE_LABELS[option] ?? option}
          </option>`,
      )}
    </select>
  </label>`;
}

/**
 * Says out loud that the page narrowed itself, and offers the way out.
 *
 * A default filter is the fastest way to make an operator think data is
 * missing. The same reasoning as the truncation notice above it: a view that
 * quietly shows a subset reads as "this is everything". The escape is a link
 * rather than an instruction to change three selects.
 */
function defaultViewNotice(
  input: { filters: ProcessorFilterValues; defaulted: boolean },
  base: string,
): Html | null {
  if (!input.defaulted) return null;
  const scope = [
    input.filters.project.length > 0 ? input.filters.project : null,
    input.filters.environment.length > 0 ? input.filters.environment : null,
    input.filters.state.length > 0 ? (STATE_LABELS[input.filters.state] ?? null) : null,
  ].filter((part): part is string => part !== null);
  if (scope.length === 0) return null;

  return html`<p class="muted filter-count">
    Default view: <strong>${scope.join(" · ")}</strong>.
    <a href="${base}?name=&amp;project=&amp;environment=&amp;state=">Show everything →</a>
  </p>`;
}

/** Projects that actually appear in the matrix, for the project menu. */
function projectOptions(cells: readonly ActivationCell[]): readonly string[] {
  return [...new Set(cells.map((cell) => cell.project_id))].sort();
}

/**
 * `(name, version)` — how an activation row and a run row find each other.
 *
 * The separator is NUL because it is the one character neither a processor
 * name nor a version can contain, so no two component pairs can collide on
 * a joined key. Write it as the `\u0000` escape, never as the byte
 * itself: a source file carrying a raw NUL is binary to ripgrep, which then
 * skips the whole file without saying so, and every repo-wide search
 * silently loses it.
 */
function processorKey(row: {
  readonly processor_name: string;
  readonly processor_version: string;
}): string {
  return `${row.processor_name}\u0000${row.processor_version}`;
}

/**
 * Count open runs per (processor, version).
 *
 * Deliberately NOT keyed on (project, environment) too: processors consume
 * every project's events off the shared stream and register cross-project
 * runs with a null `project_id`, so a per-project join would report zero for
 * every activation. Environment is left out for the same reason — a run's
 * environment is the deployment's, and matching it here would hide a run
 * whose deployment env is labelled differently from the activation's.
 */
function countRunningByProcessor(runs: readonly ProcessorRunRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.status !== "running") continue;
    const key = processorKey(run);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * "n running" or an explicit "not running".
 *
 * A blank cell would read as "unknown"; the whole point of the column is to
 * be unambiguous about a processor that is activated but absent.
 */
function runningCell(count: number): Html {
  if (count === 0) return html`<span class="badge badge-muted">not running</span>`;
  return html`<span class="badge badge-ok">${String(count)} running</span>`;
}

/** Query-param link to one activation. The key is four fields, not a slug. */
export function activationHref(row: {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
}): string {
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
  /**
   * Button-and-confirmation for the state change on offer, beside the title —
   * the same fold a destination's enable/disable sits behind. Absent when the
   * viewer may not run one.
   */
  titleAction?: Html | undefined;
  /**
   * What just happened, or why nothing may be done here — at the top of the
   * page, because after a POST this page re-renders from the top and a result
   * reported below the field list is a result nobody sees.
   */
  notice?: Html | undefined;
}): string {
  const row = input.activation;
  return page({
    ctx: input.ctx,
    title: `${row.processor_name} ${row.processor_version}`,
    ...(input.titleAction !== undefined ? { titleAction: input.titleAction } : {}),
    body: html`
      ${input.notice ?? null}

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
    `,
  });
}

/**
 * Badge for an effective state.
 *
 * `default_enabled` renders as "enabled (default)" rather than as a
 * separate colour: it IS enabled, and an operator scanning for what is
 * running must not have to learn a third status word to see it. The
 * parenthetical is what says nobody decided it.
 */
function activationStateBadge(state: EffectiveState): Html {
  if (state === "disabled") return statusBadge("disabled");
  if (state === "enabled") return statusBadge("enabled");
  return html`${statusBadge("enabled")} <span class="muted">(default)</span>`;
}
