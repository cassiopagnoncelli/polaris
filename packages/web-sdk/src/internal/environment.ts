/**
 * Browser-environment probes used by capability detection.
 *
 * Everything here is best-effort and fails closed. Storage probes write a
 * sentinel value and read it back so we detect Safari's quota-exceeded
 * private-browsing behaviour, ad-WebView storage isolation, and old IE
 * `document.cookie === ""` quirks without crashing.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *   - "WebView and in-app browser environments are treated as
 *     degraded/best-effort."
 *   - "Do not use fingerprinting to compensate for storage limitations."
 *
 * WebView detection here is a deliberately narrow heuristic on the
 * navigator user-agent string. It is NOT a fingerprint: the SDK uses it
 * only to record diagnostic context so the downstream identity resolver
 * can treat WebView identities cautiously.
 */

const COOKIE_PROBE_NAME = "__polaris_probe__";
const STORAGE_PROBE_KEY = "__polaris_probe__";

/** Resolve the `document` reference from the caller, or the global. */
export function resolveDocument(injected?: Document | undefined): Document | undefined {
  if (injected !== undefined) return injected;
  const maybe = (globalThis as { document?: Document }).document;
  return maybe;
}

/** Resolve the `window` reference from the caller, or the global. */
export function resolveWindow(injected?: Window | undefined): Window | undefined {
  if (injected !== undefined) return injected;
  const maybe = (globalThis as { window?: Window }).window;
  return maybe;
}

/** Probe whether `document.cookie` writes round-trip. */
export function isCookieAvailable(doc: Document | undefined): boolean {
  if (doc === undefined) return false;
  if (typeof doc.cookie !== "string") return false;
  try {
    // Write a sentinel with Max-Age=1 and then read it back. We do not
    // rely on the browser's eventual cleanup — `clear` below removes it.
    doc.cookie = `${COOKIE_PROBE_NAME}=1; Path=/; Max-Age=60; SameSite=Lax`;
    const present = doc.cookie.split(";").some((c) => c.trim().startsWith(`${COOKIE_PROBE_NAME}=`));
    doc.cookie = `${COOKIE_PROBE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
    return present;
  } catch {
    return false;
  }
}

/** Probe whether a Web Storage instance is writable. */
export function isWebStorageAvailable(storage: Storage | undefined): boolean {
  if (storage === undefined || storage === null) return false;
  try {
    storage.setItem(STORAGE_PROBE_KEY, "1");
    const got = storage.getItem(STORAGE_PROBE_KEY);
    storage.removeItem(STORAGE_PROBE_KEY);
    return got === "1";
  } catch {
    return false;
  }
}

/** Read localStorage off the supplied window without throwing on SecurityError. */
export function getLocalStorage(win: Window | undefined): Storage | undefined {
  if (win === undefined) return undefined;
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}

/** Read sessionStorage off the supplied window without throwing on SecurityError. */
export function getSessionStorage(win: Window | undefined): Storage | undefined {
  if (win === undefined) return undefined;
  try {
    return win.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Narrow heuristic for embedded WebView / in-app browser environments.
 *
 * Detects:
 *   - explicit Android `; wv)` marker
 *   - iOS standalone-mode flag (no Safari/CriOS/FxiOS substring on iOS UA)
 *   - in-app browsers like Instagram, Facebook, FBAN/FBAV, Line, KAKAOTALK
 *
 * This is recorded as diagnostic context only. The SDK does not change
 * identity semantics based on this signal — it is the identity resolver
 * downstream that decides how to weigh evidence from WebViews.
 */
export function detectWebView(win: Window | undefined): boolean {
  if (win === undefined) return false;
  const nav = (win as Window & { navigator?: Navigator }).navigator;
  if (nav === undefined) return false;
  const ua = nav.userAgent ?? "";
  if (ua.length === 0) return false;

  // Android WebView signal — Chrome/<v> with `; wv)` in the UA.
  if (/;\s*wv\)/i.test(ua)) return true;

  // Common in-app browsers — straight string match keeps the heuristic
  // narrow and easy to audit. We deliberately do not maintain an
  // exhaustive list; identity-resolver downstream treats anything we miss
  // as a normal browser, which is the safe default.
  const inApp = [
    "Instagram",
    "FBAN",
    "FBAV",
    "FB_IAB",
    "Twitter",
    "TikTok",
    "Pinterest",
    "Line",
    "KAKAOTALK",
    "MicroMessenger", // WeChat
  ];
  if (inApp.some((needle) => ua.includes(needle))) return true;

  // iOS WKWebView heuristic: AppleWebKit + Mobile but no Safari/CriOS/FxiOS.
  const isIosLike = /iPhone|iPad|iPod/.test(ua);
  if (isIosLike) {
    const hasBrowserMarker = /Safari\/|CriOS\/|FxiOS\/|EdgiOS\//.test(ua);
    if (!hasBrowserMarker) return true;
  }

  return false;
}

/** Detect whether the page is served over HTTPS (drives the cookie `Secure` flag). */
export function isSecureContext(win: Window | undefined): boolean {
  if (win === undefined) return false;
  // Prefer the standard `isSecureContext` flag when available; fall back
  // to a protocol check so old WebView shells still answer correctly.
  if ("isSecureContext" in win && typeof win.isSecureContext === "boolean") {
    return win.isSecureContext;
  }
  const location = (win as Window & { location?: Location }).location;
  if (location !== undefined && typeof location.protocol === "string") {
    return location.protocol === "https:";
  }
  return false;
}
