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

import { type Html, html } from "../html.js";
import { type AdminPageContext, emptyRow, envBadge, mono, page, statusBadge } from "../layout.js";
import type { ProcessorActivationRow, ProcessorRunRow } from "../queries.js";
import { ADMIN_PREFIX } from "../session.js";
import { filterForm, selectField, textField } from "./filters.js";
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
export const ACTIVATION_ENVIRONMENTS = ["development", "staging", "production"] as const;

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

/** Filter values the processors page reads from the query string. */
export interface ProcessorFilterValues {
  readonly project: string;
  readonly environment: string;
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
    if (filters.project.length > 0 && cell.project_id !== filters.project) return false;
    if (filters.environment.length > 0 && cell.environment !== filters.environment) return false;
    return true;
  });
}

export function renderProcessorsPage(input: {
  ctx: AdminPageContext;
  activations: readonly ProcessorActivationRow[];
  runs: readonly ProcessorRunRow[];
  projects: readonly string[];
  environments: readonly string[];
  filters: ProcessorFilterValues;
}): string {
  const running = countRunningByProcessor(input.runs);
  const allCells = buildActivationMatrix({
    activations: input.activations,
    runs: input.runs,
    projects: input.projects,
    environments: input.environments,
  });
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

  const activationRows =
    cells.length === 0
      ? emptyRow(8, NO_ACTIVATIONS)
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

  const runRows =
    input.runs.length === 0
      ? emptyRow(9, NO_RUNS)
      : input.runs.map(
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

  return page({
    ctx: input.ctx,
    title: "Processors",
    body: html`
      <p class="muted">
        Every (processor, version, project, environment) combination has a
        state here, whether or not anyone has decided one.
        <strong>enabled (default)</strong> means no activation row exists —
        which is RUNNING, because the gate only closes on an explicit
        disable.
        A <strong>disabled</strong> row stops that processor from acting on
        that project's events, within about ten seconds.
        <strong>Running</strong> is the process itself: a
        disabled scope still shows as running, because the process stays up
        and skips those events rather than exiting.
      </p>

      <h2>Activations</h2>
      ${filterForm(`${ADMIN_PREFIX}/processors`, [
        textField("project", "Project", input.filters.project),
        selectField(
          "environment",
          "Environment",
          ACTIVATION_ENVIRONMENTS,
          input.filters.environment,
        ),
      ])}
      ${
        omitted > 0
          ? html`<p class="notice">
              Showing ${String(shown.length)} of ${String(ordered.length)}
              combinations — ${String(omitted)} omitted. Every explicit
              decision is shown; the omitted rows are all
              <strong>enabled (default)</strong>.
            </p>`
          : html``
      }
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
            ${activationRows}
          </tbody>
        </table>
      </div>

      <h2 style="margin-top:24px">Recent runs</h2>
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
            ${runRows}
          </tbody>
        </table>
      </div>
      <p class="muted" style="margin-top:16px">
        Per-run counters are running totals for that process, flushed every 15
        seconds, so a <em>running</em> row can trail reality by about that
        long. They are triage context beside a run, not a metrics surface —
        throughput, lag, retry, and DLQ <em>rates</em> are in the Grafana
        <em>polaris-processors</em> dashboard. Processor semantics live in
        each processor's <code>processor.manifest.yaml</code>, not in the
        database.
      </p>
    `,
  });
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
