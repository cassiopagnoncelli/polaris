import { NotAUserTokenError } from "./errors.js";

/** Platform-wide role, ranked owner > admin > member > viewer > none. */
export type PlatformRole = "owner" | "admin" | "member" | "viewer" | "none";

/**
 * The namespaced key platform_role is emitted under (idp ADR-0003) so it can
 * never collide with a same-named claim from a federated token idp does not
 * control. The namespace is a stable, brand-neutral *identifier* — a URN,
 * never fetched, independent of both issuer and product brand (the platform
 * is white-labelled). It is a fixed shared wire constant that must equal
 * idp's `config.x.jwt.claim_namespace` + "platform_role" verbatim. Read
 * platform_role through `Passport.platformRole`, never by digging this key.
 */
export const PLATFORM_ROLE_CLAIM = "urn:idp:platform_role" as const;

/**
 * The pre-amendment namespaced key (idp ADR-0003 first cut). Read as a
 * transitional fallback so a token from an idp install not yet cut over to
 * the URN is still understood; dropped once no such token can remain in
 * flight (≤15 min AT TTL).
 */
export const LEGACY_PLATFORM_ROLE_CLAIM = "https://claims.entental.com/platform_role" as const;

/**
 * Raw JWT payload shape as issued by Idp — the conformant OIDC / RFC 9068
 * shape (ADR-0001): flat top-level authorization data. Access tokens carry
 * no profile fields; the profile keys below appear only on ID-token or
 * userinfo payloads, which a Passport can also wrap. Service tokens are
 * discriminated structurally by `sub === client_id` (ADR-0003).
 */
export interface TokenPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  aud?: string | string[];
  /** SSO session id the grant belongs to (absent on service tokens). */
  sid?: string;
  /** Unix time of the authentication event. */
  auth_time?: number;
  /** RFC 8176 authentication method references. */
  amr?: string[];
  /** Authentication context class: "aal1" | "aal2". */
  acr?: string;
  /** Authorization claim: platform_role under its namespaced URN key (ADR-0003 amended). */
  "urn:idp:platform_role"?: PlatformRole | null;
  /** Earlier namespaced key (ADR-0003 first cut); read only as a transitional fallback. */
  "https://claims.entental.com/platform_role"?: PlatformRole | null;
  /** Legacy bare platform_role key (pre-ADR-0003); read only as a fallback. */
  platform_role?: PlatformRole | null;
  /** Profile claims (ID-token/userinfo payloads only). */
  email?: string;
  email_verified?: unknown;
  name?: string | null;
  locale?: string | null;
  zoneinfo?: string | null;
  phone_number?: string | null;
  /** Retired (ADR-0003): pre-flip service tokens may still carry it; ignored. */
  token_use?: "client";
  /** Set on service tokens; on user tokens for OAuth-client grants. */
  client_id?: string;
  /** Space-delimited scopes (service tokens; user tokens on OAuth grants). */
  scope?: string;
}

/**
 * A decoded and verified JWT passport.
 *
 * Serves the conformant OIDC / RFC 9068 claims idp issues (ADR-0001): flat
 * authorization data — platformRole, scopes, amr/acr/authTime,
 * sid. Access tokens carry no profile fields; the profile getters yield
 * values only when wrapping an ID-token/userinfo payload and return null
 * otherwise. (2.x also read a legacy nested `user` envelope; that shape is
 * retired.)
 *
 * Service tokens (client_credentials, discriminated by `sub === client_id`)
 * throw NotAUserTokenError on user-only getters; use `service`, `clientId`,
 * `scopes`, `hasScope()` instead.
 */
export class Passport {
  constructor(public readonly claims: TokenPayload) {}

  // --- Identity ---

  get issuer(): string {
    return this.claims.iss;
  }

  get subject(): string {
    return this.claims.sub;
  }

  /**
   * The user UUID for user tokens. Throws for service tokens, where `sub`
   * is the client_id and not a user identifier — branch on `service` first.
   */
  get userUuid(): string {
    this.requireUserToken("userUuid");
    return this.claims.sub;
  }

  get issuedAt(): Date {
    return new Date(this.claims.iat * 1000);
  }

  get expiresAt(): Date {
    return new Date(this.claims.exp * 1000);
  }

  get jwtId(): string {
    return this.claims.jti;
  }

  // --- Token type discriminator ---

  /**
   * Retired (ADR-0003): client-credentials tokens no longer carry a
   * `token_use` marker — the discriminator is structural (`service`, i.e.
   * `sub === client_id`). Kept for 2.x API compatibility; always null.
   */
  get tokenUse(): string | null {
    return null;
  }

  /**
   * A client-credentials (service) token. RFC 9068's own discriminator: a
   * client-credentials token's subject IS the client, so `sub === client_id`
   * (ADR-0003). A user token carries client_id = the app but sub = the user
   * uuid ≠ client_id, so the two are unambiguous. First-party user tokens
   * carry no client_id and are never service tokens.
   */
  get service(): boolean {
    const clientId = this.claims.client_id;
    return clientId != null && clientId !== "" && this.claims.sub === clientId;
  }

  get user(): boolean {
    return !this.service;
  }

  get clientId(): string | null {
    return this.claims.client_id ?? (this.service ? this.claims.sub : null);
  }

  get scopes(): string[] {
    return (this.claims.scope ?? "").split(/\s+/).filter(Boolean);
  }

  hasScope(name: string): boolean {
    return this.scopes.includes(name);
  }

  // --- Session & authentication context ---

  /** SSO session id the grant belongs to. Null on service tokens. */
  get sid(): string | null {
    return this.claims.sid ?? null;
  }

  /**
   * Authentication method references (RFC 8176) for the sign-in the grant
   * was born from, e.g. ["pwd", "otp", "mfa"]. Empty when the grant's
   * context is unknown.
   */
  get amr(): string[] {
    return this.claims.amr ?? [];
  }

  /** Authentication context class: "aal1"/"aal2" (NIST 800-63B semantics). */
  get acr(): string | null {
    return this.claims.acr ?? null;
  }

  /** Time of the authentication event the grant was born from. */
  get authTime(): Date | null {
    return this.claims.auth_time ? new Date(this.claims.auth_time * 1000) : null;
  }

  // --- User profile ---
  // These throw NotAUserTokenError for service tokens. Access tokens carry
  // no profile fields (null there) — values come through only when
  // wrapping an ID-token/userinfo payload.

  get email(): string | null {
    this.requireUserToken("email");
    return this.claims.email ?? null;
  }

  get name(): string | null {
    this.requireUserToken("name");
    return this.claims.name ?? null;
  }

  get locale(): string | null {
    this.requireUserToken("locale");
    return this.claims.locale ?? null;
  }

  /**
   * The OIDC zoneinfo claim: an IANA tz name, absent when the user has no
   * stored preference ("Auto-detect").
   */
  get timeZone(): string | null {
    this.requireUserToken("timeZone");
    return this.claims.zoneinfo ?? null;
  }

  get phoneNumber(): string | null {
    this.requireUserToken("phoneNumber");
    return this.claims.phone_number ?? null;
  }

  /**
   * Retired (ADR-0001): tokens carry no profile timestamps. Kept for 2.x
   * API compatibility; always null.
   */
  get createdAt(): number | null {
    this.requireUserToken("createdAt");
    return null;
  }

  /**
   * Retired (ADR-0001): `emailVerified` asserts the fact the timestamp
   * used to prove. Kept for 2.x API compatibility; always null.
   */
  get confirmedAt(): number | null {
    this.requireUserToken("confirmedAt");
    return null;
  }

  get emailVerified(): boolean {
    this.requireUserToken("emailVerified");
    return this.truthyClaim(this.claims.email_verified);
  }

  /**
   * Whether the sign-in behind this grant verified a second factor
   * (amr contains "mfa", RFC 8176).
   */
  get mfaVerified(): boolean {
    this.requireUserToken("mfaVerified");
    return this.amr.includes("mfa");
  }

  /**
   * Platform-wide role claim, ranked owner > admin > member > viewer >
   * none. The tiered getters below are "at least" checks — platformAdmin
   * is true for owners too.
   */
  get platformRole(): PlatformRole | null {
    this.requireUserToken("platformRole");
    // URN key (ADR-0003 amended), falling back to the earlier namespaced key
    // and then the pre-ADR-0003 bare key for any token from a not-yet-cut-over
    // idp install (≤15 min AT TTL). Belt-and-braces for the coordinated
    // release; collapses to the URN once no older token can remain.
    return (
      this.claims[PLATFORM_ROLE_CLAIM] ??
      this.claims[LEGACY_PLATFORM_ROLE_CLAIM] ??
      this.claims.platform_role ??
      null
    );
  }

  get platformOwner(): boolean {
    return this.platformRole === "owner";
  }

  /** At least admin (owner or admin). */
  get platformAdmin(): boolean {
    const role = this.platformRole;
    return role === "owner" || role === "admin";
  }

  /** At least member (owner, admin, or member). */
  get platformMember(): boolean {
    const role = this.platformRole;
    return role === "owner" || role === "admin" || role === "member";
  }

  /** At least viewer (any role but none). */
  get platformViewer(): boolean {
    const role = this.platformRole;
    return role === "owner" || role === "admin" || role === "member" || role === "viewer";
  }

  get noPlatform(): boolean {
    return !this.platformViewer;
  }

  /**
   * Retired (ADR-0002): the status claim left the access token, because
   * idp only ever issues one to an active account — holding a passport IS
   * the assertion. Kept for 2.x API compatibility; always "active", which
   * is what every caller comparing against it expected to find.
   */
  get userStatus(): string {
    this.requireUserToken("userStatus");
    return "active";
  }

  /**
   * Retired (ADR-0001): terms left the token contract entirely. Kept for
   * 2.x API compatibility; always null.
   */
  get termsVersion(): string | null {
    this.requireUserToken("termsVersion");
    return null;
  }

  // --- Helpers ---

  get expired(): boolean {
    return Date.now() > this.claims.exp * 1000;
  }

  private requireUserToken(getter: string): void {
    if (this.service) {
      throw new NotAUserTokenError(
        `${getter} is only available on user tokens; this is a service token (clientId=${this.clientId})`,
      );
    }
  }

  private truthyClaim(value: unknown): boolean {
    if (value === true || value === 1) return true;
    if (typeof value !== "string") return false;

    return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  }
}
