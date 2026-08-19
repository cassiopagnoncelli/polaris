/**
 * Filter-form controls.
 *
 * Filters are plain GET query parameters rendered back into the form. That
 * gives shareable, bookmarkable, back-button-correct URLs and needs no
 * JavaScript — a list page is a `<form method="get">` and nothing more.
 *
 * A select beats a text box wherever the set of values is closed and the
 * page already knows it. Typing `storefont` into a project box returns an
 * empty table that looks exactly like a project with nothing in it, and
 * nothing on the page distinguishes the two; a menu of the projects that
 * exist cannot be misspelled. Free text stays only where the value really is
 * open — an actor's email, a destination id.
 */

import { type Html, html } from "../html.js";

export function textField(name: string, label: string, value: string): Html {
  return html`<label>
    <span>${label}</span>
    <input type="text" name="${name}" value="${value}" autocomplete="off" />
  </label>`;
}

/**
 * A closed set, with an explicit "any" at the top.
 *
 * `anyLabel` exists because "any" is the wrong word for some sets — a state
 * filter reads better as "any state", and on a page with four selects in a
 * row the repeated bare "any" stops saying which axis it belongs to.
 */
export function selectField(
  name: string,
  label: string,
  options: readonly string[],
  selected: string,
  anyLabel = "any",
): Html {
  return html`<label>
    <span>${label}</span>
    <select name="${name}">
      <option value="">${anyLabel}</option>
      ${options.map(
        (option) =>
          html`<option value="${option}" ${option === selected ? "selected" : ""}>
            ${option}
          </option>`,
      )}
    </select>
  </label>`;
}

export function checkboxField(name: string, label: string, checked: boolean): Html {
  return html`<label class="filter-check">
    <input type="checkbox" name="${name}" value="1" ${checked ? "checked" : ""} />
    <span>${label}</span>
  </label>`;
}

/**
 * The bar itself.
 *
 * `hidden` carries the parameters that are not filters but must survive one —
 * a tab, most often. Submitting a filter form replaces the whole query
 * string, so anything not represented by a control is dropped, and a filter
 * that silently throws the operator back to the first tab is a filter nobody
 * uses twice.
 *
 * Reset is a link to the bare action rather than a button: it clears by
 * navigating to the unfiltered URL, which is also the URL the operator wants
 * to copy.
 */
export function filterForm(
  action: string,
  fields: readonly Html[],
  hidden: Readonly<Record<string, string>> = {},
): Html {
  return html`<form method="get" action="${action}" class="filters">
    ${Object.entries(hidden).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}
    ${fields}
    <div class="filter-actions">
      <button type="submit" class="secondary">Filter</button>
      <a href="${filterHref(action, hidden)}" class="link-button">Reset</a>
    </div>
  </form>`;
}

/** The action with its non-filter parameters kept, which is what Reset means. */
function filterHref(action: string, hidden: Readonly<Record<string, string>>): string {
  const entries = Object.entries(hidden).filter(([, value]) => value.length > 0);
  if (entries.length === 0) return action;
  return `${action}?${new URLSearchParams(entries).toString()}`;
}
