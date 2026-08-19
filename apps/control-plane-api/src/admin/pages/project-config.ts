/**
 * The Variables panel on a project's detail page.
 *
 * This is the surface the project-config programme was requested for: declare
 * and edit per-`(project, environment)` values here, and they hydrate to every
 * consumer that reads them (plan §3.6).
 *
 * Two things shape the design.
 *
 * **The table is the EFFECTIVE view, not a list of rows.** An operator asking
 * "what is this project's dedupe window?" is badly served by a table that
 * shows only what someone happened to store — the answer for an unset key is
 * its component default, and that is what the panel prints, marked as a
 * default. Every key the component declares appears whether or not it has a
 * value, so the page answers the question the operator actually has. It also
 * means the same facts `polaris config validate` prints and `/health` reports
 * come from one query, three surfaces, one truth.
 *
 * **Friction is proportional to blast radius.** Only the two shapes that can
 * break delivery in one click — unsetting a required key, and setting a
 * secret reference in production — demand the ritual: the resource's label
 * typed out, and a written reason. Everything else is a value, a Save button,
 * and an audit row. Applying the ritual to every edit is precisely how
 * operators learn to type past it, which costs it its meaning on the changes
 * that need it — and a reason box on a routine edit collects "test" and
 * "fix", which is worse than the nullable column the schema already allows.
 * Every mutation is still audited, with actor, target, before and after.
 *
 * A secret-typed row shows `[redacted]`, and this page never holds anything
 * else: `listProjectConfig` masks secret values on the way out, so the
 * plaintext does not reach the renderer to be leaked by a future edit here.
 * `polaris config get --reveal` is the disclosure path.
 */

import { PROJECT_CONFIG_SCHEMAS } from "@polaris/project-config-schemas";
import type { ProjectConfigRow } from "@polaris/shared-control-plane-db";
import { POLARIS_ENVIRONMENTS, type PolarisEnvironment } from "@polaris/shared-environments";
import { describeRefusal, type MutationRefusal } from "../actions/authorize.js";
import { type Html, html } from "../html.js";
import { statCard } from "../layout.js";
import { ADMIN_PREFIX } from "../session.js";
import { actionForm } from "./actions.js";
import { formatInstant } from "./format.js";

/**
 * What a component schema says about one key.
 *
 * The bounds are carried, not just the type, because the editor turns them
 * into `min`/`max`/`minlength` on the input. A schema that already knows
 * `rate_limit_rps` must be a positive integer should not let the operator
 * discover that from a stack trace.
 */
interface DeclaredFacts {
  readonly type: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly enumValues: readonly string[] | undefined;
  readonly defaultValue: unknown;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly minLength: number | undefined;
}

/** One row of the effective view: a declared key, a stored key, or both. */
interface EffectiveEntry {
  readonly namespace: string;
  readonly key: string;
  /** Present when the key is declared by a component schema. */
  readonly declared: DeclaredFacts | undefined;
  /** Present when a value is stored for this project + environment. */
  readonly stored: ProjectConfigRow | undefined;
}

export interface ProjectConfigPanelInput {
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
  readonly rows: readonly ProjectConfigRow[];
  /** Set when a mutation was refused; re-renders the form with its values. */
  readonly refusal?: MutationRefusal | undefined;
  /**
   * The `namespace.key` the refusal was about.
   *
   * Without it the panel could only say *that* something was refused, on a
   * table of every key every component declares — and it showed the refusal
   * inside every ritual popover on the page, including the rows it had
   * nothing to do with.
   */
  readonly refusalKey?: string | undefined;
  /** True when a compare-and-set lost — another operator wrote first. */
  readonly conflictKey?: string | undefined;
  /** A refusal raised by the write path itself (mapping token, plaintext secret). */
  readonly error?: string | undefined;
  /** Substring the operator is searching `namespace.key` for. */
  readonly query?: string | undefined;
  /** Which subset of the effective view to show. */
  readonly filter?: ConfigFilter | undefined;
}

/**
 * Coerce a route parameter or query string to a row environment.
 *
 * Defaults to development rather than rejecting: the tab is a display
 * affordance, and an unknown value should land the operator somewhere safe
 * instead of on an error page. A write to a bogus environment is refused by
 * the CHECK constraint regardless.
 */
export function parseConfigEnvironment(raw: string | undefined): PolarisEnvironment {
  const candidate = (raw ?? "").trim();
  return (POLARIS_ENVIRONMENTS as readonly string[]).includes(candidate)
    ? (candidate as PolarisEnvironment)
    : "development";
}

/**
 * Strict environment parse for the WRITE path.
 *
 * The GET tab falls back to development because a tab is a display
 * affordance. A POST must not: a typoed `/config/prodution/set` URL that
 * "falls back" lands the write in a different environment than the operator
 * addressed, which is worse than failing.
 */
export function parseWriteEnvironment(raw: string): PolarisEnvironment | null {
  const candidate = raw.trim();
  return (POLARIS_ENVIRONMENTS as readonly string[]).includes(candidate)
    ? (candidate as PolarisEnvironment)
    : null;
}

export interface DeclaredKeyFacts {
  readonly declared: boolean;
  readonly secret: boolean;
  readonly required: boolean;
}

/**
 * What the generated schemas say about one key.
 *
 * The server consults this rather than trusting the form, for two decisions
 * that must not be client-controlled: whether a key is secret-typed (a write
 * omitting the `secret` flag must not store a credential as a plainly-visible
 * value — plan §3.5 assigns this check to the admin API), and whether the
 * typed-confirmation ritual applies.
 */
export function declaredKeyFacts(namespace: string, key: string): DeclaredKeyFacts {
  const entry = PROJECT_CONFIG_SCHEMAS[namespace];
  const schema = entry?.project as Record<string, unknown> | undefined;
  const properties = (schema?.["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const property = properties[key];
  if (property === undefined) return { declared: false, secret: false, required: false };
  const required = new Set((schema?.["required"] ?? []) as string[]);
  return { declared: true, secret: property["secret"] === true, required: required.has(key) };
}

/**
 * Parse a form value the way the CLI does: JSON when it parses, else a string.
 *
 * So `5000` stores a number and `graph.facebook.com` stores a string, which
 * is what an operator typing into a form expects. A secret always stays a
 * string: `project_config_secret_is_string` requires it, and a credential of
 * all digits must not be retyped as a number and lose its leading zeroes.
 */
export function parseConfigFormValue(raw: string, isSecret: boolean): unknown {
  if (isSecret) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Build the effective view: every declared key, plus every stored key the
 * schemas do not know about.
 *
 * Free-form keys are not an error. A project may declare variables no
 * component in this repo reads — that is the requirement's Vercel-style
 * declaration, and the hook for client-owned consumers under multi-tenancy
 * (plan §3.1). They are flagged so an operator can tell a deliberate extra
 * from a typo, and left alone otherwise.
 */
/**
 * A numeric schema bound, or undefined when there is nothing to tell anyone.
 *
 * The generator emits `maximum: 9007199254740991` for every integer, which is
 * `Number.MAX_SAFE_INTEGER` standing in for "no ceiling". Rendering it as a
 * constraint would put a sixteen-digit number under a field whose real
 * constraint is "a positive integer", so it is dropped here rather than
 * pattern-matched at each of the places that display or enforce it.
 */
function bound(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw === Number.MAX_SAFE_INTEGER || raw === Number.MIN_SAFE_INTEGER ? undefined : raw;
}

export function buildEffectiveView(rows: readonly ProjectConfigRow[]): readonly EffectiveEntry[] {
  const byKey = new Map<string, ProjectConfigRow>();
  for (const row of rows) byKey.set(`${row.namespace}\0${row.config_key}`, row);

  const entries: EffectiveEntry[] = [];
  const claimed = new Set<string>();

  for (const [namespace, entry] of Object.entries(PROJECT_CONFIG_SCHEMAS)) {
    const schema = entry.project as Record<string, unknown> | undefined;
    const properties = (schema?.["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema?.["required"] ?? []) as string[]);
    for (const [key, property] of Object.entries(properties)) {
      const id = `${namespace}\0${key}`;
      claimed.add(id);
      entries.push({
        namespace,
        key,
        declared: {
          type: String(property["type"] ?? "string"),
          required: required.has(key),
          secret: property["secret"] === true,
          enumValues: Array.isArray(property["enum"]) ? (property["enum"] as string[]) : undefined,
          defaultValue: property["default"],
          minimum: bound(property["minimum"]),
          maximum: bound(property["maximum"]),
          minLength: bound(property["minLength"]),
        },
        ...(byKey.has(id) ? { stored: byKey.get(id) } : { stored: undefined }),
      });
    }
  }

  for (const [id, row] of byKey) {
    if (claimed.has(id)) continue;
    entries.push({
      namespace: row.namespace,
      key: row.config_key,
      declared: undefined,
      stored: row,
    });
  }

  // Missing-required first — the reason an operator opened this page is
  // usually that something is not running.
  return entries.sort((a, b) => {
    const aMissing = isMissingRequired(a) ? 0 : 1;
    const bMissing = isMissingRequired(b) ? 0 : 1;
    if (aMissing !== bMissing) return aMissing - bMissing;
    return a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key);
  });
}

function isMissingRequired(entry: EffectiveEntry): boolean {
  return (
    entry.declared?.required === true &&
    entry.stored === undefined &&
    entry.declared.defaultValue === undefined
  );
}

/**
 * What the Variables tab is worth saying before anyone opens it.
 *
 * The panel sits behind a tab now, and the one fact it holds that cannot wait
 * — a required key with no value, on a project that is therefore not doing
 * its job — has to travel up to the tab strip. The arithmetic lives here,
 * beside the rules it depends on, rather than in the page that displays it.
 */
export interface ProjectConfigSummary {
  /** Values stored for this project and environment. */
  readonly stored: number;
  /** Required keys with neither a stored value nor a component default. */
  readonly missingRequired: number;
}

export function summariseProjectConfig(rows: readonly ProjectConfigRow[]): ProjectConfigSummary {
  // `stored` is `rows.length` directly: the effective view never drops a
  // stored row, it only pairs one with its declaration or carries it as an
  // extra, so building the view to count them again would be the same
  // arithmetic twice.
  return {
    stored: rows.length,
    missingRequired: buildEffectiveView(rows).filter(isMissingRequired).length,
  };
}

/** Whether this edit needs the typed-confirmation ritual (see module doc). */
export function needsConfirmation(input: {
  readonly action: "set" | "unset";
  readonly environment: string;
  readonly secret: boolean;
  readonly required: boolean;
}): boolean {
  if (input.action === "unset" && input.required) return true;
  return input.action === "set" && input.secret && input.environment === "production";
}

/**
 * Which rows the operator asked to see.
 *
 * A project reads every namespace every component declares, so the effective
 * view is long before anyone has stored a thing — and it only grows as
 * components are added. Filtering is a GET, like every other list in the
 * panel: the URL carries the query, so a filtered view is bookmarkable and
 * pasteable, and the whole thing still works with scripting off.
 */
export type ConfigFilter = "all" | "set" | "default" | "missing" | "secret";

const CONFIG_FILTERS: Readonly<Record<ConfigFilter, string>> = {
  all: "All",
  set: "Set here",
  default: "Using default",
  missing: "Not set",
  secret: "Secrets",
};

export function parseConfigFilter(raw: string | undefined): ConfigFilter {
  const candidate = (raw ?? "").trim();
  return candidate in CONFIG_FILTERS ? (candidate as ConfigFilter) : "all";
}

function matchesFilter(entry: EffectiveEntry, filter: ConfigFilter): boolean {
  switch (filter) {
    case "set":
      return entry.stored !== undefined;
    case "default":
      return entry.stored === undefined && entry.declared?.defaultValue !== undefined;
    case "missing":
      return entry.stored === undefined;
    case "secret":
      return entry.declared?.secret === true || entry.stored?.is_secret === true;
    default:
      return true;
  }
}

function matchesQuery(entry: EffectiveEntry, query: string): boolean {
  if (query.length === 0) return true;
  return `${entry.namespace}.${entry.key}`.toLowerCase().includes(query.toLowerCase());
}

export function renderProjectConfigPanel(input: ProjectConfigPanelInput): Html {
  const entries = buildEffectiveView(input.rows);
  const base = `${ADMIN_PREFIX}/projects/${encodeURIComponent(input.projectId)}`;
  const query = (input.query ?? "").trim();
  const filter = input.filter ?? "all";

  const visible = entries.filter(
    (entry) => matchesFilter(entry, filter) && matchesQuery(entry, query),
  );

  // Counted over everything, never over what survived the filter: a summary
  // that moves when you type in the search box is not a summary.
  const setCount = entries.filter((entry) => entry.stored !== undefined).length;
  const defaulted = entries.filter(
    (entry) => entry.stored === undefined && entry.declared?.defaultValue !== undefined,
  ).length;
  const missing = entries.filter(isMissingRequired);
  const secrets = entries.filter(
    (entry) => entry.declared?.secret === true || entry.stored?.is_secret === true,
  ).length;

  // Filter and search ride along on the environment pills. Switching
  // environment to compare the same key across two of them is the reason
  // anyone filters here, and dropping the filter on the way is what makes a
  // filter feel like it is fighting you.
  const carry = [
    query.length > 0 ? `&q=${encodeURIComponent(query)}` : "",
    filter !== "all" ? `&filter=${filter}` : "",
  ].join("");

  const envPills = POLARIS_ENVIRONMENTS.map(
    (env) =>
      html`<a
        class="${env === input.environment ? "seg-option current" : "seg-option"}"
        href="${base}?tab=variables&amp;env=${env}${carry}"
        aria-current="${env === input.environment ? "page" : "false"}"
        >${env}</a
      >`,
  );

  return html`
    <section class="panel">
      <p class="muted panel-lede">
        Per-environment values for this project. Consumers read these instead
        of deployment environment variables, and a change reaches running
        services within seconds. Keys with no stored value show the component
        default — that is what the service will use.
      </p>

      <div class="seg" role="group" aria-label="Environment">${envPills}</div>

      ${renderNotices(input, missing.length)}

      <div class="cards compact">
        ${statCard({ label: "Set here", value: String(setCount) })}
        ${statCard({ label: "Using default", value: String(defaulted) })}
        ${statCard({ label: "Not set", value: String(missing.length) })}
        ${statCard({ label: "Secrets", value: String(secrets) })}
      </div>

      ${renderToolbar(input, base, query, filter, visible.length, entries.length)}
      ${renderGroups(input, visible, query, filter)}
      ${renderRevealHint(input, entries)}
    </section>
  `;
}

/** Everything that went wrong, above the thing it went wrong in. */
function renderNotices(input: ProjectConfigPanelInput, missing: number): Html {
  return html`
    ${
      input.refusal !== undefined
        ? html`<p class="notice error">
            ${
              input.refusalKey !== undefined
                ? html`<strong>${input.refusalKey}</strong> was not changed.`
                : null
            }
            ${describeRefusal(input.refusal)}
          </p>`
        : null
    }
    ${input.error !== undefined ? html`<p class="notice error">${input.error}</p>` : null}
    ${
      input.conflictKey !== undefined
        ? html`<p class="notice warn">
            <strong>${input.conflictKey}</strong> changed while this page was
            open — another operator wrote first. Reload to see the current
            value before editing again; nothing was overwritten.
          </p>`
        : null
    }
    ${
      missing > 0
        ? html`<p class="notice error">
            ${String(missing)} required ${missing === 1 ? "key has" : "keys have"}
            no value in <strong>${input.environment}</strong>. Components fall
            back to their own defaults where they have one, and skip work where
            they do not.
          </p>`
        : null
    }
  `;
}

/**
 * Search, filter, and the one button that creates something.
 *
 * `Declare a variable` used to sit under the table, which put the only
 * creating action on the page below however many rows the schemas happened to
 * produce. It belongs beside the search box, where every other tool in this
 * category puts it.
 */
function renderToolbar(
  input: ProjectConfigPanelInput,
  base: string,
  query: string,
  filter: ConfigFilter,
  shown: number,
  total: number,
): Html {
  const filtered = shown !== total;

  return html`
    <div class="toolbar">
      <form method="get" action="${base}" class="toolbar-search" role="search">
        <input type="hidden" name="tab" value="variables" />
        <input type="hidden" name="env" value="${input.environment}" />
        <label class="visually-hidden" for="var-q">Search keys</label>
        <input
          type="search"
          id="var-q"
          name="q"
          value="${query}"
          placeholder="Search keys…"
          autocomplete="off"
          spellcheck="false"
        />
        <label class="visually-hidden" for="var-filter">Filter</label>
        <select id="var-filter" name="filter">
          ${Object.entries(CONFIG_FILTERS).map(
            ([value, label]) =>
              html`<option value="${value}" ${value === filter ? "selected" : ""}>
                ${label}
              </option>`,
          )}
        </select>
        <button type="submit" class="secondary">Apply</button>
        ${
          filtered || query.length > 0
            ? html`<a class="link-button" href="${base}?tab=variables&amp;env=${input.environment}"
                >Clear</a
              >`
            : null
        }
      </form>
      <div class="toolbar-actions">
        ${
          filtered
            ? html`<span class="muted toolbar-count"
                >${String(shown)} of ${String(total)}</span
              >`
            : null
        }
        ${renderAddForm(input)}
      </div>
    </div>
  `;
}

/**
 * Rows, grouped by the component that reads them.
 *
 * Alphabetical across the whole set interleaved `braze`, `ga4` and `ingest`
 * into one undifferentiated list, so the answer to "what does GA4 need from
 * me" had to be assembled by eye. The group is also where the count of what
 * is actually set belongs — per component, that number is a status; summed
 * over the project it is trivia.
 *
 * Missing-required keys still float to the top of their own group, for the
 * same reason `buildEffectiveView` sorts them first.
 */
function renderGroups(
  input: ProjectConfigPanelInput,
  entries: readonly EffectiveEntry[],
  query: string,
  filter: ConfigFilter,
): Html {
  if (entries.length === 0) {
    return html`<p class="empty-state">
      ${
        query.length > 0 || filter !== "all"
          ? html`No keys match this filter.`
          : html`No component declares configuration yet, and nothing is stored
            for this environment.`
      }
    </p>`;
  }

  const groups = new Map<string, EffectiveEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.namespace);
    if (group === undefined) groups.set(entry.namespace, [entry]);
    else group.push(entry);
  }

  return html`<div class="var-groups">
    ${[...groups].map(([namespace, rows]) => {
      const set = rows.filter((row) => row.stored !== undefined).length;
      return html`<section class="var-group">
        <header class="var-group-head">
          <h3>${namespace}</h3>
          <span class="muted"
            >${String(set)} of ${String(rows.length)} set in ${input.environment}</span
          >
        </header>
        <div class="var-list">${rows.map((row) => renderRow(input, row))}</div>
      </section>`;
    })}
  </div>`;
}

/**
 * One key: read at rest, edit on demand.
 *
 * A `<details>` per row, rather than a text input per row. The old table put
 * every key into edit mode at once — eighteen live form fields whose values
 * could not be scanned, on a page whose most common use is reading one
 * number. Opening a row is what asks to change it.
 *
 * The editor expands the row in place instead of floating over it. A popover
 * would be clipped: `.table-wrap` and any scroll container establish one, and
 * a confirmation card that opens half-hidden behind the edge of its own table
 * is worse than no fold at all.
 */
function renderRow(input: ProjectConfigPanelInput, entry: EffectiveEntry): Html {
  const stored = entry.stored;
  const declared = entry.declared;
  const missingRequired = isMissingRequired(entry);
  const label = `${entry.namespace}.${entry.key}`;
  const secret = declared?.secret === true || stored?.is_secret === true;

  const chips = [
    declared === undefined
      ? html`<span class="chip chip-unknown" title="No component schema declares this key"
          >undeclared</span
        >`
      : html`<span class="chip">${declared.type}</span>`,
    declared?.required === true ? html`<span class="chip chip-req">required</span>` : null,
    secret ? html`<span class="chip chip-secret">secret</span>` : null,
  ];

  const value = (() => {
    if (stored === undefined) {
      if (declared?.defaultValue !== undefined) {
        return html`<code class="val val-default">${JSON.stringify(declared.defaultValue)}</code>
          <span class="val-tag">default</span>`;
      }
      return missingRequired
        ? html`<span class="val val-missing">Not set</span>`
        : html`<span class="val val-empty">Not set</span>`;
    }
    if (stored.is_secret) {
      // `stored.value` is already `SECRET_MASK` — `listProjectConfig` masks on
      // the way out, so this page never holds the plaintext to begin with.
      // Rendering it rather than hard-coding the mask keeps one spelling, and
      // means a future unmasked read shows up here as a visible regression
      // rather than silently rendering a credential.
      return html`<code class="val">${String(stored.value)}</code>`;
    }
    return html`<code class="val">${JSON.stringify(stored.value)}</code>`;
  })();

  const meta =
    stored === undefined
      ? null
      : html`<span class="var-meta"
          >${formatInstant(stored.updated_at)} · ${stored.updated_by}</span
        >`;

  // Opened when this is the row that was just refused, so the error and the
  // form it came from are on screen together rather than the operator having
  // to find the row again and re-open it.
  const openRow = input.refusalKey === label && input.refusal !== undefined;

  const cls = missingRequired ? "var var-alert" : "var";
  const inner = html`<summary class="var-head">
      <span class="var-key">
        <code>${entry.key}</code>
        <span class="chips">${chips}</span>
      </span>
      <span class="var-val">${value}</span>
      ${meta}
      <span class="var-caret" aria-hidden="true"></span>
    </summary>
    <div class="var-body">${renderRowEditor(input, entry, label, secret)}</div>`;

  return openRow
    ? html`<details class="${cls}" open>${inner}</details>`
    : html`<details class="${cls}">${inner}</details>`;
}

/** The set form and, for a stored key, the unset beside it. */
function renderRowEditor(
  input: ProjectConfigPanelInput,
  entry: EffectiveEntry,
  label: string,
  secret: boolean,
): Html {
  const base = `${ADMIN_PREFIX}/projects/${encodeURIComponent(input.projectId)}/config/${encodeURIComponent(input.environment)}`;
  const required = entry.declared?.required === true;

  const hidden: Record<string, string> = {
    namespace: entry.namespace,
    key: entry.key,
    secret: secret ? "true" : "false",
    // Compare-and-set: empty for an unset key, which the handler reads as
    // "expect no row".
    expected_updated_at: entry.stored?.updated_at ?? "",
  };

  // Only the row the refusal was actually about. Passing it to every form
  // told an operator that the edit they never made had been rejected.
  const refusal =
    input.refusal !== undefined && input.refusalKey === label ? { refusal: input.refusal } : {};

  const setForm = needsConfirmation({
    action: "set",
    environment: input.environment,
    secret,
    required,
  })
    ? actionForm({
        action: `${base}/set`,
        submitLabel: entry.stored !== undefined ? "Replace secret" : "Set secret",
        expectedConfirmation: label,
        description: secret
          ? "Stores a provider reference. A plaintext credential is refused — Polaris never stores secret values, only pointers to them."
          : "Sets this value for every consumer reading this project and environment.",
        environment: input.environment,
        danger: true,
        hidden,
        ...refusal,
      })
    : renderInlineSetForm(base, entry, hidden, secret);

  const unsetForm =
    entry.stored === undefined
      ? null
      : needsConfirmation({ action: "unset", environment: input.environment, secret, required })
        ? actionForm({
            action: `${base}/unset`,
            submitLabel: "Unset",
            expectedConfirmation: label,
            description:
              "Removes the stored value. This key is REQUIRED — the component falls back to its own default if it has one, and skips work if it does not.",
            environment: input.environment,
            danger: true,
            hidden: { namespace: entry.namespace, key: entry.key },
            ...refusal,
          })
        : html`<form method="post" action="${base}/unset" class="var-unset">
            <input type="hidden" name="namespace" value="${entry.namespace}" />
            <input type="hidden" name="key" value="${entry.key}" />
            <button type="submit" class="ghost-danger">Unset</button>
          </form>`;

  return html`${setForm}${unsetForm}`;
}

/**
 * The everyday path: the right control for the declared type, and Save.
 *
 * The schema's bounds become the input's, so `rate_limit_rps` refuses `0` at
 * the field rather than at the CHECK constraint, and an enum is a menu rather
 * than a string an operator has to spell. None of it replaces the server's
 * own validation — it just moves the ordinary mistake to where it is cheap.
 */
function renderInlineSetForm(
  base: string,
  entry: EffectiveEntry,
  hidden: Record<string, string>,
  secret: boolean,
): Html {
  const declared = entry.declared;
  const current = entry.stored === undefined ? "" : rawValue(entry.stored.value);

  const field = (() => {
    if (secret) {
      return html`<input
        type="text"
        name="value"
        value="${current}"
        placeholder="vault:polaris/production/…"
        autocomplete="off"
        spellcheck="false"
        required
      />`;
    }
    if (declared?.enumValues !== undefined) {
      return html`<select name="value" required>
        ${declared.enumValues.map(
          (option) =>
            html`<option value="${option}" ${option === current ? "selected" : ""}>
              ${option}
            </option>`,
        )}
      </select>`;
    }
    if (declared?.type === "boolean") {
      return html`<select name="value" required>
        <option value="true" ${current === "true" ? "selected" : ""}>true</option>
        <option value="false" ${current === "false" ? "selected" : ""}>false</option>
      </select>`;
    }
    if (declared?.type === "integer" || declared?.type === "number") {
      return html`<input
        type="number"
        name="value"
        value="${current}"
        ${declared.type === "integer" ? html`step="1"` : null}
        ${declared.minimum !== undefined ? html`min="${String(declared.minimum)}"` : null}
        ${declared.maximum !== undefined ? html`max="${String(declared.maximum)}"` : null}
        required
      />`;
    }
    // An object or array is JSON, and JSON does not fit on one line. The
    // handler parses it with the same `parseConfigFormValue` the CLI uses, so
    // what is typed here and what `polaris config set` accepts are one syntax.
    if (declared?.type === "object" || declared?.type === "array") {
      return html`<textarea name="value" rows="5" spellcheck="false" required>${current}</textarea>`;
    }
    return html`<input
      type="text"
      name="value"
      value="${current}"
      autocomplete="off"
      spellcheck="false"
      ${declared?.minLength !== undefined ? html`minlength="${String(declared.minLength)}"` : null}
      required
    />`;
  })();

  return html`<form method="post" action="${base}/set" class="var-edit">
    ${Object.entries(hidden).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    <label>
      <span>Value${secret ? html` <span class="muted">— a reference, not the credential</span>` : null}</span>
      ${field}
    </label>
    ${renderHint(declared)}
    <button type="submit">Save</button>
  </form>`;
}

/**
 * What the schema knows, said in one line under the field.
 *
 * Type, bounds, allowed values, and the default that applies when nothing is
 * stored. All of it was previously discoverable only by submitting something
 * wrong and reading the refusal.
 */
function renderHint(declared: DeclaredFacts | undefined): Html {
  if (declared === undefined) {
    return html`<p class="field-hint">
      No component schema declares this key, so nothing validates it. It is
      stored and hydrated; components that do not read it ignore it.
    </p>`;
  }

  const parts: Html[] = [html`<code>${declared.type}</code>`];
  if (declared.enumValues !== undefined) {
    parts.push(html`one of ${declared.enumValues.map((v) => html`<code>${v}</code> `)}`);
  }
  if (declared.minimum !== undefined && declared.maximum !== undefined) {
    parts.push(html`between ${String(declared.minimum)} and ${String(declared.maximum)}`);
  } else if (declared.minimum !== undefined) {
    parts.push(html`at least ${String(declared.minimum)}`);
  } else if (declared.maximum !== undefined) {
    parts.push(html`at most ${String(declared.maximum)}`);
  }
  // `minLength: 1` is the generator's way of saying "not empty", which the
  // `required` attribute on the input already enforces and already explains.
  if (declared.minLength !== undefined && declared.minLength > 1) {
    parts.push(html`at least ${String(declared.minLength)} characters`);
  }
  if (declared.defaultValue !== undefined) {
    parts.push(html`default <code>${JSON.stringify(declared.defaultValue)}</code>`);
  }
  if (declared.required) parts.push(html`required`);

  return html`<p class="field-hint">
    ${parts.map((part, index) => (index === 0 ? part : html` · ${part}`))}
  </p>`;
}

/** Render a stored jsonb value for an input field. */
function rawValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/**
 * How to read a masked value back — as a command, not a button.
 *
 * The same call `pages/keys.ts` makes for key material, and for the same
 * reason: a credential rendered in a browser lands in the DOM, devtools,
 * bfcache, screenshots, and any proxy that logs response bodies. A reveal
 * route here would be a second disclosure path bought for the convenience of
 * not opening a terminal, on a design whose value comes from having few.
 *
 * Rendered only when the scope actually has a secret, so a project with none
 * does not get told how to reveal one.
 */
function renderRevealHint(
  input: ProjectConfigPanelInput,
  entries: readonly EffectiveEntry[],
): Html {
  const secret = entries.find(
    (entry) => entry.declared?.secret === true || entry.stored?.is_secret === true,
  );
  if (secret === undefined) return html``;
  return html`
    <h2>Reading a masked value</h2>
    <p class="muted">
      Secret values show as <code>[redacted]</code> here and in exports, and
      are never rendered in a browser. Read one from a terminal:
    </p>
    <code class="cli"
      >polaris config get --project ${input.projectId} --env ${input.environment} --namespace
      ${secret.namespace} --key ${secret.key} --reveal</code
    >
  `;
}

/**
 * Declare a key no component schema knows about.
 *
 * The requirement is Vercel-style: the project page is where a variable comes
 * into existence, not only where blanks created by a repo PR get filled. A
 * future client-owned consumer has no schema in this repo at all, so its
 * variables cannot be schema-declared here.
 *
 * There is deliberately NO bulk `.env` import. It is the feature an operator
 * would most expect and the one that would hurt: it invites pasting a file
 * containing live credentials as plain values, straight past the secret-ref
 * refusal. The backfill job is the sanctioned path.
 */
function renderAddForm(input: ProjectConfigPanelInput): Html {
  const base = `${ADMIN_PREFIX}/projects/${encodeURIComponent(input.projectId)}/config/${encodeURIComponent(input.environment)}`;
  const namespaces = Object.keys(PROJECT_CONFIG_SCHEMAS);

  return html`
    <details class="confirm">
      <summary class="confirm-trigger primary">New variable</summary>
      <form method="post" action="${base}/add" class="action-form">
        <p class="muted">
          Adds a key for <strong>${input.environment}</strong>. A key no
          component declares is stored and hydrated, and flagged in the list —
          components ignore keys they do not read, so an unrecognised name is
          inert rather than dangerous.
        </p>
        <label>
          <span>Namespace (the component that reads it)</span>
          <input
            type="text"
            name="namespace"
            list="known-namespaces"
            autocomplete="off"
            spellcheck="false"
            required
          />
        </label>
        <datalist id="known-namespaces">
          ${namespaces.map((namespace) => html`<option value="${namespace}"></option>`)}
        </datalist>
        <label>
          <span>Key (lowercase snake_case)</span>
          <input type="text" name="key" autocomplete="off" spellcheck="false" required />
        </label>
        <label>
          <span>Value</span>
          <input type="text" name="value" autocomplete="off" required />
        </label>
        <label class="checkbox">
          <input type="checkbox" name="secret" value="true" />
          <span>Sensitive — mask this value in lists, exports and the audit log</span>
        </label>
        <button type="submit">Declare</button>
      </form>
    </details>
  `;
}
