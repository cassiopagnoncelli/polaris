/**
 * The three pre-session pages: sign in, forbidden, signed out.
 *
 * Rendering only — the flow itself lives in `../plugin.ts`. These render
 * without an `AdminPageContext` because by definition there is no session
 * yet (or, for forbidden, no usable one).
 *
 * None of them is on the ordinary path in. Signing in is a redirect, not a
 * page: these are the three ways it can go wrong.
 */

import { html } from "../html.js";
import { barePage } from "../layout.js";
import type { PlatformRoleName } from "../platform-role.js";
import { AUTH_PREFIX, SIGN_IN_PATH } from "../session.js";

/**
 * Why a sign-in attempt came back without a session.
 *
 * Every member is a way the Idp round trip itself failed — there is no
 * "you are signed out" member, because that case never reaches this page.
 * An operator with no session is sent straight to `/auth/start`; only a flow
 * that already broke stops here, which is also what stops it retrying forever.
 */
export type LoginReason =
  | "invalid_token"
  | "state_mismatch"
  | "missing_verifier"
  | "exchange_failed"
  | "idp_error";

const REASON_TEXT: Readonly<Record<LoginReason, string>> = {
  invalid_token: "Idp returned a session that could not be verified. Please try again.",
  state_mismatch: "The sign-in attempt could not be verified. Please try again.",
  missing_verifier: "The sign-in attempt timed out before it completed. Please try again.",
  exchange_failed: "Idp could not complete the sign-in. Please try again.",
  idp_error: "Idp refused the sign-in. Please try again, or contact a platform administrator.",
};

/**
 * The retry page for a failed sign-in.
 *
 * The button is deliberately a button and not a redirect: this page is only
 * reached when the round trip just failed, and bouncing straight back into it
 * would loop the browser rather than tell anyone what went wrong.
 */
export function renderLoginPage(input: { reason: LoginReason; next: string | null }): string {
  return barePage(
    "Sign in",
    html`
      <p class="notice error">${REASON_TEXT[input.reason]}</p>
      <!-- A GET: starting the flow only writes two single-use cookies before
           redirecting, and a forced login is not an attack worth a token. -->
      <form method="get" action="${AUTH_PREFIX}/start">
        ${input.next !== null ? html`<input type="hidden" name="next" value="${input.next}" />` : null}
        <button type="submit">Continue with Idp</button>
      </form>
      <p class="muted" style="margin-top:18px">
        Access requires a platform role of <strong>admin</strong> or
        <strong>owner</strong>.
      </p>
    `,
  );
}

export function renderForbiddenPage(role: PlatformRoleName): string {
  return barePage(
    "Access denied",
    html`
      <p class="notice error">
        Your platform role is <strong>${role}</strong>. The Polaris admin panel
        requires <strong>admin</strong> or <strong>owner</strong>.
      </p>
      <p class="muted">
        There is no read-only tier: this panel exposes API keys, destination
        state, and DLQ triage, so everything below admin is denied.
      </p>
      <p class="muted">
        Ask a platform administrator to grant you a role, or sign out and use a
        different account.
      </p>
      <form method="post" action="${AUTH_PREFIX}/logout">
        <button type="submit" class="secondary">Sign out</button>
      </form>
    `,
  );
}

export function renderSignedOutPage(): string {
  return barePage(
    "Signed out",
    html`
      <p>You have been signed out of Polaris and of Idp.</p>
      <p>
        <a href="${SIGN_IN_PATH}">Sign in again</a>
      </p>
    `,
  );
}

/** Shown when a POST fails the same-origin check. */
export function renderOriginRefusedPage(): string {
  return barePage(
    "Request refused",
    html`
      <p class="notice error">
        That request did not come from this site, so it was refused before
        anything changed.
      </p>
      <p class="muted">
        If you reached this page by submitting a Polaris form, return to the
        panel and try again.
      </p>
      <p><a href="/admin">Back to Polaris</a></p>
    `,
  );
}
