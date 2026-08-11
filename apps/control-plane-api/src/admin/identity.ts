/**
 * The signed admin identity cookie.
 *
 * Ported from `haws/src/admin/adminIdentity.ts`.
 *
 * Idp access tokens carry authorization data only — no profile claims (idp
 * ADR-0001). The operator's email arrives once, in the ID token at callback
 * time, and it is the value that lands in `audit_records.actor_label`. So it
 * has to survive between requests, and it has to be unforgeable: a client
 * that can edit this cookie can attribute its own mutations to someone else.
 *
 * Hence a signed cookie rather than a plain one. The payload is not secret —
 * it is signed, not encrypted — but it cannot be tampered with.
 *
 * Two properties worth keeping when editing this file:
 *
 *   - The HMAC key is **derived** from the configured secret, never the
 *     secret itself, so the same value can safely also be an OAuth client
 *     secret without one use weakening the other.
 *   - Verification is constant-time (`timingSafeEqual`) and length-checked
 *     first, because `timingSafeEqual` throws on a length mismatch.
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Bumped if the payload shape changes, so old cookies fail closed. */
const VERSION = "v1";

/** Domain separation: this key signs identity cookies and nothing else. */
const KEY_PURPOSE = "polaris-admin-identity-cookie-v1";

export interface AdminIdentity {
  /** Idp user uuid — must match the access token's `sub` to be trusted. */
  readonly sub: string;
  readonly email: string | null;
  readonly name: string | null;
  /** Raw ID token, kept solely as the `id_token_hint` for RP-initiated logout. */
  readonly idToken: string | null;
}

export class AdminIdentityCodec {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac("sha256", KEY_PURPOSE).update(secret).digest();
  }

  encode(identity: AdminIdentity): string {
    const payload = Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
    return `${VERSION}.${payload}.${this.sign(payload)}`;
  }

  /** Returns null for anything that is not a well-formed, correctly signed cookie. */
  decode(value: string | undefined): AdminIdentity | null {
    if (value === undefined || value.length === 0) return null;

    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [version, payload, signature] = parts;
    if (version !== VERSION || payload === undefined || signature === undefined) return null;

    const expected = this.sign(payload);
    // timingSafeEqual throws unless both buffers are the same length, so the
    // length check is a guard, not an early-exit optimisation.
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return toAdminIdentity(decoded);
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(`${VERSION}.${payload}`).digest("base64url");
  }
}

function toAdminIdentity(value: unknown): AdminIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const sub = record["sub"];
  if (typeof sub !== "string" || sub.length === 0) return null;
  return {
    sub,
    email: typeof record["email"] === "string" ? record["email"] : null,
    name: typeof record["name"] === "string" ? record["name"] : null,
    idToken: typeof record["idToken"] === "string" ? record["idToken"] : null,
  };
}

/**
 * Decode an identity cookie and accept it only if it belongs to the passport
 * presenting it.
 *
 * A correctly signed cookie for a *different* subject is still refused: the
 * pairing is what makes the email trustworthy as an audit actor. Signature
 * alone would let an operator keep a stale identity across a re-login as
 * someone else.
 */
export function bindIdentity(
  identity: AdminIdentity | null,
  passportSubject: string,
): AdminIdentity | null {
  if (identity === null) return null;
  return identity.sub === passportSubject ? identity : null;
}
