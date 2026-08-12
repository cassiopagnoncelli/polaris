/**
 * Mutation forms.
 *
 * Plain `<form method="post">` — no JavaScript, no `window.confirm`. The
 * confirmation ritual is server-validated, because a client-side one protects
 * nobody: it is exactly the layer an operator learns to click through.
 *
 * Each form demands two things: the resource's human label typed out, and a
 * reason of at least ten characters that lands verbatim in
 * `audit_records.reason`. Production rows additionally require a higher
 * platform role — see `../actions/authorize.ts`.
 */

import { describeRefusal, MIN_REASON_LENGTH, type MutationRefusal } from "../actions/authorize.js";
import { type Html, html } from "../html.js";
import type { PlatformRoleName } from "../platform-role.js";

export interface ActionFormInput {
  /** Where the form POSTs. */
  readonly action: string;
  /** Button text, e.g. "Disable destination". */
  readonly submitLabel: string;
  /** What the operator must type: the resource's human label. */
  readonly expectedConfirmation: string;
  /** Human sentence describing the consequence. */
  readonly description: string;
  /** Environment of the target row, so the form itself carries the warning. */
  readonly environment: string;
  /** Whether this is a destructive-looking action (styles the button). */
  readonly danger: boolean;
  /** Refusal to render above the form, when re-rendering after a failure. */
  readonly refusal?: MutationRefusal | undefined;
  /** Values the operator already typed, preserved across a failed attempt. */
  readonly previous?: { confirmation: string; reason: string } | undefined;
  /**
   * Extra fields the target needs to identify itself.
   *
   * Processor activations are keyed by four columns rather than a single id,
   * so they ride in the body. They go INSIDE this form — a wrapping form
   * would be nested markup, which browsers do not submit.
   */
  readonly hidden?: Readonly<Record<string, string>> | undefined;
}

export function actionForm(input: ActionFormInput): Html {
  const isProduction = input.environment === "production";
  return html`
    <form method="post" action="${input.action}" class="${input.danger ? "action-form danger" : "action-form"}">
      ${
        input.refusal !== undefined
          ? html`<p class="notice error">${describeRefusal(input.refusal)}</p>`
          : null
      }
      ${
        isProduction
          ? html`<p class="notice warn">
              This is a <strong>production</strong> resource. The change takes
              effect immediately.
            </p>`
          : null
      }
      ${
        input.hidden !== undefined
          ? Object.entries(input.hidden).map(
              ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
            )
          : null
      }
      <p class="muted">${input.description}</p>
      <!--
        The caption is one element, not a run of text nodes around a <code>:
        the stylesheet lays a label out as a grid of caption-then-input, and
        loose text nodes each become a row of their own.
      -->
      <label>
        <span>Type <code>${input.expectedConfirmation}</code> to confirm</span>
        <input
          type="text"
          name="confirm"
          autocomplete="off"
          spellcheck="false"
          value="${input.previous?.confirmation ?? ""}"
          required
        />
      </label>
      <label>
        <span>Reason (recorded in the audit log, min ${String(MIN_REASON_LENGTH)} characters)</span>
        <input
          type="text"
          name="reason"
          autocomplete="off"
          value="${input.previous?.reason ?? ""}"
          required
        />
      </label>
      <button type="submit" class="${input.danger ? "danger" : ""}">${input.submitLabel}</button>
    </form>
  `;
}

/** Rendered above a detail page after a mutation succeeds or no-ops. */
export function mutationResultNotice(input: {
  applied: boolean;
  appliedText: string;
  noopText: string;
  auditId: string | null;
}): Html {
  if (!input.applied) {
    return html`<p class="notice">${input.noopText}</p>`;
  }
  return html`<p class="notice">
    ${input.appliedText}
    ${input.auditId !== null ? html`<span class="muted"> · audit ${input.auditId}</span>` : null}
  </p>`;
}

/**
 * Shown instead of the forms when the viewer's role is below what this
 * environment requires, so the reason is visible before anything is typed.
 */
export function actionsUnavailable(input: {
  required: PlatformRoleName;
  actual: PlatformRoleName;
  environment: string;
}): Html {
  return html`<p class="notice">
    Changing a <strong>${input.environment}</strong> resource requires the
    <strong>${input.required}</strong> platform role. Yours is
    <strong>${input.actual}</strong>.
  </p>`;
}
