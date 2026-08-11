export class IdpJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdpJwtError";
  }
}

export class VerificationError extends IdpJwtError {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

export class ExpiredTokenError extends VerificationError {
  constructor(message = "Access token has expired") {
    super(message);
    this.name = "ExpiredTokenError";
  }
}

export class InvalidSignatureError extends VerificationError {
  constructor(message = "Invalid token signature") {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

export class InvalidIssuerError extends VerificationError {
  constructor(message = "Invalid token issuer") {
    super(message);
    this.name = "InvalidIssuerError";
  }
}

export class InvalidAudienceError extends VerificationError {
  constructor(message = "Invalid token audience") {
    super(message);
    this.name = "InvalidAudienceError";
  }
}

export class RevokedTokenError extends VerificationError {
  constructor(message = "Token has been revoked") {
    super(message);
    this.name = "RevokedTokenError";
  }
}

export class NotAUserTokenError extends IdpJwtError {
  constructor(message: string) {
    super(message);
    this.name = "NotAUserTokenError";
  }
}

export class ClientCredentialsError extends IdpJwtError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ClientCredentialsError";
  }
}

export class RefreshError extends IdpJwtError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RefreshError";
  }

  /**
   * Transport-level failure (network error, timeout, 5xx): the refresh token
   * is presumed still valid — keep the session and retry later. Treating
   * these like a dead grant forces a fresh OAuth grant (a new IdP session)
   * on every blip.
   */
  get transient(): boolean {
    return this.code === "network_error" || this.status >= 500;
  }

  /**
   * The IdP deliberately rejected the grant (revoked, expired, replayed, or
   * a client-auth problem): only a fresh login can recover.
   */
  get invalidGrant(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}
