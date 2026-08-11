/**
 * Filter-form controls.
 *
 * Filters are plain GET query parameters rendered back into the form. That
 * gives shareable, bookmarkable, back-button-correct URLs and needs no
 * JavaScript — a list page is a `<form method="get">` and nothing more.
 */

import { type Html, html } from "../html.js";

export function textField(name: string, label: string, value: string): Html {
  return html`<label>
    ${label}
    <input type="text" name="${name}" value="${value}" />
  </label>`;
}

export function selectField(
  name: string,
  label: string,
  options: readonly string[],
  selected: string,
): Html {
  return html`<label>
    ${label}
    <select name="${name}">
      <option value="">any</option>
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
  return html`<label style="flex-direction:row;align-items:center;gap:6px">
    <input type="checkbox" name="${name}" value="1" ${checked ? "checked" : ""} style="min-width:auto" />
    ${label}
  </label>`;
}

export function filterForm(action: string, fields: readonly Html[]): Html {
  return html`<form method="get" action="${action}" class="filters">
    ${fields}
    <button type="submit" class="secondary">Filter</button>
    <a href="${action}" class="link-button" style="padding:7px 6px">Reset</a>
  </form>`;
}
