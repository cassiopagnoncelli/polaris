/**
 * First-party cookie storage layer.
 *
 * The preferred persistence layer per `docs/architecture/10-sdk-standards.md`:
 *
 *   - `SameSite=Lax` by default. Third-party cookies are forbidden.
 *   - `Secure` is set when the page is served over HTTPS, configurable
 *     via {@link CookieOptions.secure}.
 *   - Cookie `Domain` is configurable so identity can be shared across
 *     subdomains (e.g. `.example.com`).
 *
 * We persist the identity record as a single JSON-encoded cookie because
 * one cookie per field would (a) bloat every request header by O(n)
 * fields and (b) make subdomain rollout finicky when only some fields
 * are present. The cookie reader treats any malformed payload as
 * "nothing stored" and falls forward — same policy as every other layer.
 */

import type { CookieOptions, IdentityStore, PersistedIdentity, StorageLayer } from "../types.js";
import { deserializeIdentity, serializeIdentity } from "./serialize.js";

const DEFAULT_COOKIE_NAME = "polaris_id";
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 * 13; // ~13 months
const DEFAULT_PATH = "/";

export interface CookieStoreInputs {
  readonly document: Document | undefined;
  readonly options?: CookieOptions | undefined;
  /** Whether the page is loaded over HTTPS (drives the `Secure` flag). */
  readonly secureContext: boolean;
}

export class CookieStore implements IdentityStore {
  public readonly layer: StorageLayer = "cookie";
  private readonly doc: Document | undefined;
  private readonly name: string;
  private readonly domain: string | undefined;
  private readonly path: string;
  private readonly maxAgeSeconds: number;
  private readonly sameSite: "Lax" | "Strict";
  private readonly secure: boolean;

  public constructor(inputs: CookieStoreInputs) {
    this.doc = inputs.document;
    this.name = inputs.options?.name ?? DEFAULT_COOKIE_NAME;
    this.domain = inputs.options?.domain;
    this.path = inputs.options?.path ?? DEFAULT_PATH;
    this.maxAgeSeconds = inputs.options?.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    this.sameSite = inputs.options?.sameSite ?? "Lax";
    this.secure = inputs.options?.secure ?? inputs.secureContext;
  }

  public isAvailable(): boolean {
    if (this.doc === undefined) return false;
    if (typeof this.doc.cookie !== "string") return false;
    try {
      const probeName = `${this.name}__probe`;
      const probeAttrs = this.buildAttributes(60);
      this.doc.cookie = `${probeName}=1; ${probeAttrs}`;
      const present = this.readRaw(probeName) === "1";
      this.doc.cookie = `${probeName}=; ${this.buildAttributes(0)}`;
      return present;
    } catch {
      return false;
    }
  }

  public read(): PersistedIdentity | null {
    if (this.doc === undefined) return null;
    const raw = this.readRaw(this.name);
    if (raw === null) return null;
    try {
      return deserializeIdentity(decodeURIComponent(raw));
    } catch {
      // Corrupt percent-encoding — fall forward like any other malformed read.
      return null;
    }
  }

  public write(identity: PersistedIdentity): boolean {
    if (this.doc === undefined) return false;
    try {
      const value = encodeURIComponent(serializeIdentity(identity));
      const attrs = this.buildAttributes(this.maxAgeSeconds);
      this.doc.cookie = `${this.name}=${value}; ${attrs}`;
      return this.readRaw(this.name) !== null;
    } catch {
      return false;
    }
  }

  public clear(): boolean {
    if (this.doc === undefined) return false;
    try {
      this.doc.cookie = `${this.name}=; ${this.buildAttributes(0)}`;
      // Real browsers remove the cookie immediately when Max-Age=0; some
      // test DOMs (happy-dom included) keep the empty cookie around until
      // the next tick. Both states are "cleared" for the SDK's purposes —
      // any future `read()` will fall through deserialization and return
      // null.
      const remaining = this.readRaw(this.name);
      return remaining === null || remaining.length === 0;
    } catch {
      return false;
    }
  }

  private readRaw(name: string): string | null {
    if (this.doc === undefined) return null;
    const all = this.doc.cookie;
    if (typeof all !== "string" || all.length === 0) return null;
    const prefix = `${name}=`;
    for (const entry of all.split(";")) {
      const trimmed = entry.trim();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length);
      }
    }
    return null;
  }

  private buildAttributes(maxAge: number): string {
    const parts: string[] = [`Path=${this.path}`, `Max-Age=${maxAge}`, `SameSite=${this.sameSite}`];
    if (this.domain !== undefined && this.domain.length > 0) {
      parts.push(`Domain=${this.domain}`);
    }
    if (this.secure) {
      parts.push("Secure");
    }
    return parts.join("; ");
  }
}
