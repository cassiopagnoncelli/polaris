/**
 * The Idp OAuth client: authorize URL, code exchange, revoke, end-session.
 *
 * Ported from `haws/src/admin/idpProxy.ts`. Everything here is plain `fetch`
 * against Idp's documented endpoints — no OAuth library. The whole
 * authorization-code + PKCE flow this service needs is the four methods
 * below, and a dependency would replace code that fits on one screen.
 *
 * Framework-agnostic on purpose: no Fastify types cross this boundary, so it
 * is unit-testable without a server and portable if the UI ever moves.
 *
 * Endpoints (see `~/src/idp/config/routes.rb`):
 *   GET  /oauth/authorize     code + S256 PKCE
 *   POST /oauth/token         grant_type=authorization_code, HTTP Basic client auth
 *   POST /oauth/revoke        RFC 7009, refresh tokens only
 *   GET  /oauth/end_session   RP-initiated logout
 */

import { createHash, randomBytes } from "node:crypto";

import type { AdminIdpConfig } from "./config.js";

/** Raised for any non-2xx or unreachable Idp response. */
export class IdpProxyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly idpCode: string | null,
  ) {
    super(message);
    this.name = "IdpProxyError";
  }
}

export interface IdpTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly id_token?: string;
  readonly refresh_token?: string;
}

/**
 * The OAuth operations the plugin performs.
 *
 * An interface so tests drive the callback without a live Idp — the same seam
 * `operatorTokenRepository` and `AdminQueries` already provide. The
 * code-exchange path is where the most consequential decisions live (role
 * checked before cookies are set), so it has to be exercisable.
 */
export interface IdpOAuthClient {
  buildAuthorizeUrl(state: string, codeVerifier: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<IdpTokenResponse>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  buildEndSessionUrl(input: { postLogoutRedirectUri: string; idTokenHint: string | null }): string;
}

/**
 * RFC 7636 code verifier: 32 random bytes, base64url — 43 characters, inside
 * Idp's accepted `[A-Za-z0-9\-._~]{43,128}`.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** OAuth `state`: opaque, single-use, compared on the callback. */
export function generateState(): string {
  return randomBytes(32).toString("hex");
}

export class IdpProxy implements IdpOAuthClient {
  constructor(private readonly config: AdminIdpConfig) {}

  buildAuthorizeUrl(state: string, codeVerifier: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      // Idp does not currently enforce scope-to-claim mapping (its ADR-0003
      // roadmap item 6 is accepted but unimplemented), but request the
      // standard set anyway so this keeps working when it does.
      scope: "openid profile email",
      state,
      code_challenge: codeChallengeFor(codeVerifier),
      code_challenge_method: "S256",
    });
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   *
   * Client authentication is HTTP Basic (RFC 6749 §2.3.1); Idp accepts either
   * that or form parameters, and Basic keeps the secret out of the body.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<IdpTokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    const payload = await this.post<Record<string, unknown>>(this.config.tokenUrl, body);

    const accessToken = payload["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new IdpProxyError(
        "Idp token response carried no access_token",
        502,
        "invalid_response",
      );
    }
    return {
      access_token: accessToken,
      token_type: typeof payload["token_type"] === "string" ? payload["token_type"] : "Bearer",
      expires_in: typeof payload["expires_in"] === "number" ? payload["expires_in"] : 0,
      ...(typeof payload["id_token"] === "string" ? { id_token: payload["id_token"] } : {}),
      ...(typeof payload["refresh_token"] === "string"
        ? { refresh_token: payload["refresh_token"] }
        : {}),
    };
  }

  /**
   * Revoke a refresh token (RFC 7009).
   *
   * Access tokens are not revocable — they age out on their own TTL. Killing
   * the refresh token is what stops the session being renewed, and it is what
   * fans a real single-logout out to other consumers over Idp's revocation
   * channel.
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.post(this.config.revokeUrl, new URLSearchParams({ token: refreshToken }));
  }

  /**
   * RP-initiated logout URL.
   *
   * Without this last hop the browser's Idp session survives and the next
   * visit to /admin re-authenticates silently — which looks exactly like
   * logout not working.
   */
  buildEndSessionUrl(input: { postLogoutRedirectUri: string; idTokenHint: string | null }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri: input.postLogoutRedirectUri,
    });
    if (input.idTokenHint !== null) params.set("id_token_hint", input.idTokenHint);
    return `${this.config.endSessionEndpoint}?${params.toString()}`;
  }

  private async post<T>(url: string, body: URLSearchParams): Promise<T> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString(
      "base64",
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${basic}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new IdpProxyError(`Idp request failed: ${cause}`, 502, "network_error");
    } finally {
      clearTimeout(timer);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      // Revocation returns an empty 200 body; a broken error body should not
      // mask the status code below.
    }

    if (!response.ok) {
      const description = payload["error_description"];
      const code = payload["error"];
      throw new IdpProxyError(
        typeof description === "string" ? description : `Idp returned ${response.status}`,
        response.status,
        typeof code === "string" ? code : null,
      );
    }

    return payload as T;
  }
}
