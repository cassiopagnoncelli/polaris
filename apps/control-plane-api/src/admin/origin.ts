/**
 * Same-origin enforcement for state-changing admin requests.
 *
 * `SameSite=Lax` on the session cookie already blocks cross-site POST in
 * every current browser, so this is defence in depth rather than the primary
 * control. It earns its ~40 lines against two things Lax does not cover: a
 * browser bug, and a same-site-but-untrusted subdomain (Lax is site-scoped,
 * not origin-scoped, so `evil.example.com` is "same site" as
 * `polaris.example.com`).
 *
 * `haws` ships no CSRF defence at all beyond `SameSite=Lax` — a gap worth
 * closing here rather than inheriting, because this UI drives forms rather
 * than same-origin `fetch`.
 *
 * Two signals, in order:
 *
 *   1. `Sec-Fetch-Site` — set by the browser, unforgeable by page script.
 *      `same-origin` passes; `none` (a typed URL or bookmark) passes because
 *      it cannot be an attacker-initiated cross-site POST.
 *   2. `Origin` — the fallback for user agents without Fetch Metadata. Must
 *      match the origin the request itself arrived on.
 *
 * A request carrying neither header is refused. Browsers send `Origin` on
 * every POST, so the only callers that omit both are non-browser clients —
 * which have `/v1/*` and a bearer token, and no business posting HTML forms.
 */

import type { FastifyRequest } from "fastify";

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

export function verifySameOrigin(request: FastifyRequest): OriginVerdict {
  const fetchSite = headerValue(request, "sec-fetch-site");
  if (fetchSite !== undefined) {
    // `none` means the navigation had no initiator — a bookmark, a typed
    // address. Not reachable from an attacker's page.
    if (fetchSite === "same-origin" || fetchSite === "none") return { ok: true };
    return { ok: false, reason: `sec-fetch-site: ${fetchSite}` };
  }

  const origin = headerValue(request, "origin");
  if (origin === undefined) {
    return { ok: false, reason: "no Origin or Sec-Fetch-Site header" };
  }

  const expected = expectedOrigin(request);
  if (origin.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: `Origin ${origin} does not match ${expected}` };
  }
  return { ok: true };
}

/**
 * The origin this request arrived on.
 *
 * `request.protocol` honours `X-Forwarded-Proto` only when Fastify is built
 * with `trustProxy`, which this service is not — so behind a TLS-terminating
 * proxy it reports `http`. That is fine here: both sides of the comparison
 * are derived from the same request, so a scheme mismatch cannot arise. It
 * would matter only if this were compared against a configured absolute URL.
 */
function expectedOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
