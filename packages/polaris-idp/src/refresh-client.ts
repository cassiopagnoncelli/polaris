import { RefreshError } from "./errors.js";

export interface RefreshClientOptions {
  /** Idp OAuth token endpoint, e.g. "https://idp.example.com/oauth/token". */
  tokenUrl: string;
  /**
   * Confidential client_id registered in Idp, and it must be THE client the
   * refresh tokens were issued to. Idp refuses a token belonging to another
   * client (RFC 6749 §6) with the same answer it gives for one that does not
   * exist. It did not always check — so an app could refresh tokens minted for
   * a different client and appear to work — and it now does.
   */
  clientId: string;
  /** Confidential client_secret registered in Idp. */
  clientSecret: string;
  /** HTTP timeout in milliseconds. Default: 5000. */
  httpTimeoutMs?: number;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * RefreshClient — exchanges an Idp refresh token for a fresh access token
 * via the OAuth `refresh_token` grant on the Idp `/oauth/token` endpoint.
 *
 * Uses HTTP Basic auth for client credentials (RFC 6749 §2.3.1).
 */
export class RefreshClient {
  private readonly opts: Required<RefreshClientOptions>;

  constructor(opts: RefreshClientOptions) {
    if (!opts.tokenUrl) throw new Error("tokenUrl is required");
    if (!opts.clientId) throw new Error("clientId is required");
    if (!opts.clientSecret) throw new Error("clientSecret is required");

    this.opts = {
      tokenUrl: opts.tokenUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      httpTimeoutMs: opts.httpTimeoutMs ?? 5_000,
    };
  }

  /**
   * @param opts.userAgent The end-user's browser User-Agent, forwarded as
   *   X-Client-User-Agent so the IdP keeps device attribution (and its
   *   impossible-client heuristic) intact through rotation — without it the
   *   rotated session records this server's HTTP client instead.
   */
  async refresh(refreshToken: string, opts?: { userAgent?: string }): Promise<RefreshResult> {
    if (!refreshToken) {
      throw new RefreshError("refresh_token is required", 400, "invalid_request");
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.httpTimeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basic}`,
    };
    if (opts?.userAgent) {
      headers["X-Client-User-Agent"] = opts.userAgent;
    }

    let response: Response;
    try {
      response = await fetch(this.opts.tokenUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new RefreshError(`Refresh request failed: ${cause}`, 502, "network_error");
    } finally {
      clearTimeout(timer);
    }

    let payload: RawTokenResponse = {};
    try {
      payload = (await response.json()) as RawTokenResponse;
    } catch {
      // ignore — handled below
    }

    if (!response.ok) {
      throw new RefreshError(
        payload.error_description ?? `Refresh failed with status ${response.status}`,
        response.status,
        payload.error ?? "refresh_failed",
      );
    }

    if (!payload.access_token || !payload.refresh_token) {
      throw new RefreshError("Idp response missing tokens", 502, "invalid_response");
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresIn: payload.expires_in ?? 0,
      tokenType: payload.token_type ?? "Bearer",
    };
  }
}
