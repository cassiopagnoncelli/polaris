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
 * **Friction is proportional to blast radius.** Every mutation records a
 * reason. Only the two shapes that can break delivery in one click — unsetting
 * a required key, and setting a secret reference in production — demand the
 * typed-confirmation ritual. Applying it to every value edit is precisely how
 * operators learn to type past it, which costs the ritual its meaning on the
 * changes that need it.
 *
 * Values are never resolved here. A secret-typed row shows its
 * `<provider>:<ref>` pointer, matching how `pages/destinations.ts` already
 * renders `secret_ref`.
 */

import { PROJECT_CONFIG_SCHEMAS } from "@polaris/project-config-schemas";
import type { ProjectConfigRow } from "@polaris/shared-control-plane-db";
import { POLARIS_ENVIRONMENTS, type PolarisEnvironment } from "@polaris/shared-environments";
import type { MutationRefusal } from "../actions/authorize.js";
import { describeRefusal } from "../actions/authorize.js";
import { type Html, html } from "../html.js";
import { emptyRow, mono } from "../layout.js";
import { ADMIN_PREFIX } from "../session.js";
import { confirmAction } from "./actions.js";
import { formatInstant } from "./format.js";

/** One row of the effective view: a declared key, a stored key, or both. */
interface EffectiveEntry {
  readonly namespace: string;
  readonly key: string;
  /** Present when the key is declared by a component schema. */
  readonly declared:
    | {
        readonly type: string;
        readonly required: boolean;
        readonly secret: boolean;
        readonly enumValues: readonly string[] | undefined;
        readonly defaultValue: unknown;
      }
    | undefined;
  /** Present when a value is stored for this project + environment. */
  readonly stored: ProjectConfigRow | undefined;
}

export interface ProjectConfigPanelInput {
  readonly projectId: string;
  readonly environment: PolarisEnvironment;
  readonly rows: readonly ProjectConfigRow[];
  /** Set when a mutation was refused; re-renders the form with its values. */
  readonly refusal?: MutationRefusal | undefined;
  /** True when a compare-and-set lost — another operator wrote first. */
  readonly conflictKey?: string | undefined;
  /** A refusal raised by the write path itself (mapping token, plaintext secret). */
  readonly error?: string | undefined;
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
 * omitting the `secret_ref` flag must not store a credential as a plain
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
 * is what an operator typing into a form expects. A secret reference always
 * stays a string — a ref that happens to look numeric is still a ref.
 */
export function parseConfigFormValue(raw: string, isSecretRef: boolean): unknown {
  if (isSecretRef) return raw;
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

export function renderProjectConfigPanel(input: ProjectConfigPanelInput): Html {
  const entries = buildEffectiveView(input.rows);
  const missing = entries.filter(isMissingRequired);
  const base = `${ADMIN_PREFIX}/projects/${encodeURIComponent(input.projectId)}`;

  const tabs = POLARIS_ENVIRONMENTS.map(
    (env) =>
      html`<a
        class="${env === input.environment ? "env-tab active" : "env-tab"}"
        href="${base}?env=${env}"
        >${env}</a
      >`,
  );

  return html`
    <section class="panel">
      <h2>Variables</h2>
      <p class="muted">
        Per-environment values for this project. Consumers read these instead of
        deployment environment variables; a change reaches running services
        within seconds. Component defaults are shown for keys with no stored
        value — they are what the service will use.
      </p>
      <div class="env-tabs">${tabs}</div>
      ${
        input.refusal !== undefined
          ? html`<p class="notice error">${describeRefusal(input.refusal)}</p>`
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
        missing.length > 0
          ? html`<p class="notice error">
              ${String(missing.length)} required
              ${missing.length === 1 ? "key has" : "keys have"} no value in
              <strong>${input.environment}</strong>. Components fall back to
              their own defaults where they have one, and skip work where they
              do not.
            </p>`
          : null
      }
      ${renderTable(input, entries)}
      ${renderAddForm(input)}
    </section>
  `;
}

function renderTable(input: ProjectConfigPanelInput, entries: readonly EffectiveEntry[]): Html {
  if (entries.length === 0) {
    return html`<div class="table-wrap">
      <table>
        <tbody>
          ${emptyRow(
            5,
            "No component declares configuration yet, and nothing is stored for this environment.",
          )}
        </tbody>
      </table>
    </div>`;
  }

  const rows = entries.map((entry) => renderRow(input, entry));
  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            <th>Source</th>
            <th>Last change</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

function renderRow(input: ProjectConfigPanelInput, entry: EffectiveEntry): Html {
  const stored = entry.stored;
  const declared = entry.declared;
  const missingRequired = isMissingRequired(entry);
  const label = `${entry.namespace}.${entry.key}`;

  const valueCell = (() => {
    if (stored === undefined) {
      if (declared?.defaultValue !== undefined) {
        return html`<span class="muted">${JSON.stringify(declared.defaultValue)}</span>`;
      }
      return html`<span class="muted">—</span>`;
    }
    if (stored.is_secret_ref) {
      // The pointer, never a resolved value. Nothing on the write side ever
      // stored one, so there is nothing here to leak.
      return html`<span class="badge">secret</span> ${mono(String(stored.value))}`;
    }
    return mono(JSON.stringify(stored.value));
  })();

  const source = (() => {
    if (stored !== undefined) return html`<span class="badge ok">set</span>`;
    if (declared === undefined) return html`<span class="badge">unknown</span>`;
    if (missingRequired) return html`<span class="badge error">required, unset</span>`;
    return html`<span class="badge muted">default</span>`;
  })();

  const flag =
    declared === undefined
      ? html`<br /><span class="muted">unknown to any component schema</span>`
      : null;

  return html`<tr>
    <td>${mono(label)}${flag}</td>
    <td>${valueCell}</td>
    <td>${source}</td>
    <td>
      ${
        stored !== undefined
          ? html`${formatInstant(stored.updated_at)}<br /><span class="muted"
                >${stored.updated_by}</span
              >`
          : html`<span class="muted">—</span>`
      }
    </td>
    <td>${renderRowActions(input, entry)}</td>
  </tr>`;
}

function renderRowActions(input: ProjectConfigPanelInput, entry: EffectiveEntry): Html {
  const label = `${entry.namespace}.${entry.key}`;
  const base = `${ADMIN_PREFIX}/projects/${encodeURIComponent(input.projectId)}/config/${encodeURIComponent(input.environment)}`;
  const secret = entry.declared?.secret === true || entry.stored?.is_secret_ref === true;
  const required = entry.declared?.required === true;

  const setNeedsRitual = needsConfirmation({
    action: "set",
    environment: input.environment,
    secret,
    required,
  });

  const hidden: Record<string, string> = {
    namespace: entry.namespace,
    key: entry.key,
    secret_ref: secret ? "true" : "false",
    // Compare-and-set: empty for an unset key, which the handler reads as
    // "expect no row".
    expected_updated_at: entry.stored?.updated_at ?? "",
  };

  const setForm = setNeedsRitual
    ? confirmAction({
        action: `${base}/set`,
        submitLabel: stored(entry) ? "Replace secret" : "Set secret",
        expectedConfirmation: label,
        description: secret
          ? "Stores a provider reference. A plaintext credential is refused — Polaris never stores secret values, only pointers to them."
          : "Sets this value for every consumer reading this project and environment.",
        environment: input.environment,
        danger: true,
        hidden,
        ...(input.refusal !== undefined ? { refusal: input.refusal } : {}),
      })
    : renderInlineSetForm(base, entry, hidden, secret);

  const unsetForm =
    entry.stored === undefined
      ? null
      : needsConfirmation({
            action: "unset",
            environment: input.environment,
            secret,
            required,
          })
        ? confirmAction({
            action: `${base}/unset`,
            submitLabel: "Unset",
            expectedConfirmation: label,
            description:
              "Removes the stored value. This key is REQUIRED — the component falls back to its own default if it has one, and skips work if it does not.",
            environment: input.environment,
            danger: true,
            hidden: { namespace: entry.namespace, key: entry.key },
            ...(input.refusal !== undefined ? { refusal: input.refusal } : {}),
          })
        : html`<form method="post" action="${base}/unset" class="action-form inline">
            <input type="hidden" name="namespace" value="${entry.namespace}" />
            <input type="hidden" name="key" value="${entry.key}" />
            <input
              type="text"
              name="reason"
              placeholder="Reason (audited)"
              autocomplete="off"
              required
            />
            <button type="submit">Unset</button>
          </form>`;

  return html`${setForm}${unsetForm}`;
}

function stored(entry: EffectiveEntry): boolean {
  return entry.stored !== undefined;
}

/** The everyday path: type a value, give a reason, submit. */
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
      return html`<input type="number" name="value" value="${current}" required />`;
    }
    return html`<input type="text" name="value" value="${current}" autocomplete="off" required />`;
  })();

  return html`<form method="post" action="${base}/set" class="action-form inline">
    ${Object.entries(hidden).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    ${field}
    <input type="text" name="reason" placeholder="Reason (audited)" autocomplete="off" required />
    <button type="submit">Save</button>
  </form>`;
}

/** Render a stored jsonb value for an input field. */
function rawValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
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
      <summary class="confirm-trigger">Declare a variable</summary>
      <form method="post" action="${base}/add" class="action-form">
        <p class="muted">
          Adds a key for <strong>${input.environment}</strong>. A key no
          component declares is stored and hydrated, and flagged in the table
          above — components ignore keys they do not read, so an unrecognised
          name is inert rather than dangerous.
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
          <input type="checkbox" name="secret_ref" value="true" />
          <span>This is a secret reference (<code>provider:ref</code>), not a value</span>
        </label>
        <label>
          <span>Reason (recorded in the audit log)</span>
          <input type="text" name="reason" autocomplete="off" required />
        </label>
        <button type="submit">Declare</button>
      </form>
    </details>
  `;
}
