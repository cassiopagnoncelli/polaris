/**
 * DOM helpers shared by Web SDK tests.
 *
 * The Web SDK identity layer is built around `document.cookie`, so the
 * tests need direct cookie manipulation to set up scenarios and reset
 * between cases. Biome's `noDocumentCookie` rule normally steers callers
 * toward the Cookie Store API, which happy-dom does not implement and
 * which is not the API the SDK itself uses. We funnel the writes through
 * this helper so the one ignore-directive lives next to the explanation.
 */

export function clearAllCookies(): void {
  const all = document.cookie;
  if (typeof all !== "string" || all.length === 0) return;
  for (const entry of all.split(";")) {
    const name = entry.split("=")[0]?.trim();
    if (name !== undefined && name.length > 0) {
      // biome-ignore lint/suspicious/noDocumentCookie: cleaning up after the SDK's own cookie writes.
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  }
}

/** Write a raw cookie value (used to seed malformed-payload scenarios). */
export function setRawCookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: deliberate raw cookie write for test fixtures.
  document.cookie = value;
}
