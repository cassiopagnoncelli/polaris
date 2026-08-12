/**
 * The operator's light/dark preference, as a cookie.
 *
 * A preference has to survive navigation, and this panel runs no JavaScript —
 * so `localStorage` is not available and the choice has to round-trip through
 * the server. That turns out to be the better mechanism anyway: the theme is
 * already decided when the document is written, so there is no flash of the
 * wrong palette on every page load.
 *
 * `system` is a real stored value, not the absence of one. "Follow the OS" is
 * a choice an operator can make *back to*, so it needs to be expressible;
 * treating it as "no cookie" would work only until they wanted to return to it
 * from a pinned theme.
 *
 * Deliberately not in `session.ts`. Everything there is a credential cleared
 * at sign-out; this is a display preference that should still be there at the
 * next sign-in, and it is the only admin cookie that is not `HttpOnly` —
 * there is nothing in it to steal.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { ADMIN_PREFIX } from "./session.js";

export const THEME_COOKIE = "polaris_admin_theme" as const;

export type AdminTheme = "system" | "light" | "dark";

/** Follow the operating system until told otherwise. */
export const DEFAULT_THEME: AdminTheme = "system";

/** Menu order, and the only values accepted from a form body. */
export const THEME_OPTIONS: ReadonlyArray<{ value: AdminTheme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** A preference lasts until it is changed. */
const THEME_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

function isTheme(value: string): value is AdminTheme {
  return THEME_OPTIONS.some((option) => option.value === value);
}

/** Anything unrecognised — a stale cookie, a hand-crafted form — is the default. */
export function parseTheme(value: string | undefined): AdminTheme {
  return value !== undefined && isTheme(value) ? value : DEFAULT_THEME;
}

export function readTheme(request: FastifyRequest): AdminTheme {
  return parseTheme(request.cookies[THEME_COOKIE]);
}

export function setThemeCookie(
  reply: FastifyReply,
  theme: AdminTheme,
  options: { secure: boolean },
): void {
  reply.setCookie(THEME_COOKIE, theme, {
    path: ADMIN_PREFIX,
    httpOnly: false,
    sameSite: "lax",
    secure: options.secure,
    maxAge: THEME_COOKIE_MAX_AGE_SEC,
  });
}
