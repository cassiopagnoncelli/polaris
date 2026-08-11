/**
 * Idp wire-contract tests.
 *
 * These pin the parts of the Idp token contract Polaris depends on. The
 * vendored code in `src/` is a snapshot of a private upstream package
 * (see README.md), so the risk on an upstream bump is not that the vendored
 * code stops compiling — it is that Idp changes what it *emits* and the
 * vendored snapshot silently stops understanding it.
 *
 * Each assertion below corresponds to something Idp's `TokenService` does
 * today (`~/src/idp/app/services/token_service.rb`):
 *
 *   - ES256, `typ: "at+jwt"` protected header (RFC 9068)
 *   - `aud` defaults to the issuer string (idp ADR-0001)
 *   - `platform_role` under the `urn:idp:` namespace (idp ADR-0003)
 *   - role vocabulary owner > admin > member > viewer > none
 *   - service tokens discriminated structurally by `sub === client_id`
 *
 * If one of these fails after an Idp release, the failure names exactly which
 * part of the contract moved.
 */

import * as jose from "jose";
import { describe, expect, it } from "vitest";

import {
  ExpiredTokenError,
  type IdpConfig,
  InvalidAudienceError,
  InvalidIssuerError,
  InvalidSignatureError,
  idpConfig,
  JwksClient,
  LEGACY_PLATFORM_ROLE_CLAIM,
  NotAUserTokenError,
  Passport,
  PLATFORM_ROLE_CLAIM,
  type PlatformRole,
  RevokedTokenError,
  VerificationError,
  Verifier,
} from "../src/index.js";

const ISSUER = "http://localhost:3011";
const KID = "test-key-1";

/** Resolves the locally generated public key, bypassing any network JWKS fetch. */
class StubJwksClient extends JwksClient {
  constructor(
    config: IdpConfig,
    private readonly publicKey: jose.CryptoKey,
    private readonly kid: string,
  ) {
    super(config);
  }

  override getKeyResolver(): ReturnType<typeof jose.createRemoteJWKSet> {
    const resolver = async (header: jose.JWSHeaderParameters): Promise<jose.CryptoKey> => {
      if (header.kid !== this.kid) {
        throw new jose.errors.JWKSNoMatchingKey();
      }
      return this.publicKey;
    };
    return resolver as unknown as ReturnType<typeof jose.createRemoteJWKSet>;
  }
}

interface Harness {
  readonly config: IdpConfig;
  readonly verify: (token: string) => Promise<Passport>;
  readonly sign: (
    claims: Record<string, unknown>,
    options?: { typ?: string | null; kid?: string; key?: jose.CryptoKey },
  ) => Promise<string>;
  readonly otherPrivateKey: jose.CryptoKey;
}

async function harness(overrides: Partial<IdpConfig> = {}): Promise<Harness> {
  const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
  const other = await jose.generateKeyPair("ES256", { extractable: true });
  const config = idpConfig({
    jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    issuer: ISSUER,
    ...overrides,
  });
  const verifier = new Verifier({
    config,
    jwksClient: new StubJwksClient(config, publicKey, KID),
  });

  const sign = async (
    claims: Record<string, unknown>,
    options: { typ?: string | null; kid?: string; key?: jose.CryptoKey } = {},
  ): Promise<string> => {
    const header: jose.JWTHeaderParameters = {
      alg: "ES256",
      kid: options.kid ?? KID,
    };
    // `typ: null` deliberately omits the header, to prove it is required.
    if (options.typ !== null) header.typ = options.typ ?? "at+jwt";
    return new jose.SignJWT(claims).setProtectedHeader(header).sign(options.key ?? privateKey);
  };

  return { config, verify: (t) => verifier.verify(t), sign, otherPrivateKey: other.privateKey };
}

function userClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    sub: "usr_01960000000000000000000000",
    aud: ISSUER,
    iat: now,
    exp: now + 900,
    jti: "tok_000000000000",
    sid: "ses_000000000000",
    auth_time: now,
    amr: ["pwd"],
    acr: "aal1",
    [PLATFORM_ROLE_CLAIM]: "admin",
    ...overrides,
  };
}

describe("Idp token contract", () => {
  it("accepts the access-token shape Idp mints and reads platform_role", async () => {
    const h = await harness();
    const passport = await h.verify(await h.sign(userClaims()));

    expect(passport.subject).toBe("usr_01960000000000000000000000");
    expect(passport.platformRole).toBe("admin");
    expect(passport.platformAdmin).toBe(true);
    expect(passport.user).toBe(true);
    expect(passport.service).toBe(false);
    expect(passport.sid).toBe("ses_000000000000");
    expect(passport.amr).toEqual(["pwd"]);
    expect(passport.acr).toBe("aal1");
  });

  it("strips a Bearer prefix, so a raw header value can be passed through", async () => {
    const h = await harness();
    const token = await h.sign(userClaims());
    await expect(h.verify(`Bearer ${token}`)).resolves.toBeInstanceOf(Passport);
    await expect(h.verify(`bearer ${token}`)).resolves.toBeInstanceOf(Passport);
  });

  // --- RFC 9068 typing --------------------------------------------------

  it("requires the at+jwt type header, so an ID token cannot be used as an access token", async () => {
    const h = await harness();
    // Idp signs ID tokens with the same key and no typ header at all.
    await expect(h.verify(await h.sign(userClaims(), { typ: null }))).rejects.toThrow(
      VerificationError,
    );
    await expect(h.verify(await h.sign(userClaims(), { typ: "JWT" }))).rejects.toThrow(
      VerificationError,
    );
  });

  // --- Audience / issuer ------------------------------------------------

  it("defaults the expected audience to the issuer string", async () => {
    const h = await harness();
    expect(h.config.audience).toBeNull();
    await expect(h.verify(await h.sign(userClaims({ aud: ISSUER })))).resolves.toBeInstanceOf(
      Passport,
    );
    await expect(h.verify(await h.sign(userClaims({ aud: "https://elsewhere" })))).rejects.toThrow(
      InvalidAudienceError,
    );
  });

  it("honours an explicit audience when Idp runs with a custom JWT_AUDIENCE", async () => {
    const h = await harness({ audience: "polaris" });
    await expect(h.verify(await h.sign(userClaims({ aud: "polaris" })))).resolves.toBeInstanceOf(
      Passport,
    );
    await expect(h.verify(await h.sign(userClaims({ aud: ISSUER })))).rejects.toThrow(
      InvalidAudienceError,
    );
  });

  it("refuses a foreign issuer", async () => {
    const h = await harness();
    await expect(h.verify(await h.sign(userClaims({ iss: "https://evil" })))).rejects.toThrow(
      InvalidIssuerError,
    );
  });

  // --- Signature / expiry -----------------------------------------------

  it("refuses a token signed by another key, and one whose kid is unknown", async () => {
    const h = await harness();
    await expect(h.verify(await h.sign(userClaims(), { key: h.otherPrivateKey }))).rejects.toThrow(
      InvalidSignatureError,
    );
    await expect(h.verify(await h.sign(userClaims(), { kid: "rotated-away" }))).rejects.toThrow(
      InvalidSignatureError,
    );
  });

  it("refuses an expired token, allowing for the configured clock skew", async () => {
    const h = await harness();
    const now = Math.floor(Date.now() / 1000);
    // Inside the 30s default skew.
    await expect(h.verify(await h.sign(userClaims({ exp: now - 10 })))).resolves.toBeInstanceOf(
      Passport,
    );
    // Well outside it.
    await expect(h.verify(await h.sign(userClaims({ exp: now - 3600 })))).rejects.toThrow(
      ExpiredTokenError,
    );
  });

  // --- platform_role claim ----------------------------------------------

  it("reads platform_role through the URN key, then the documented fallbacks", async () => {
    const h = await harness();

    const urn = await h.verify(await h.sign(userClaims({ [PLATFORM_ROLE_CLAIM]: "owner" })));
    expect(urn.platformRole).toBe("owner");

    const legacyClaims = userClaims({ [LEGACY_PLATFORM_ROLE_CLAIM]: "admin" });
    delete legacyClaims[PLATFORM_ROLE_CLAIM];
    expect((await h.verify(await h.sign(legacyClaims))).platformRole).toBe("admin");

    const bareClaims = userClaims({ platform_role: "member" });
    delete bareClaims[PLATFORM_ROLE_CLAIM];
    expect((await h.verify(await h.sign(bareClaims))).platformRole).toBe("member");

    const noneClaims = userClaims();
    delete noneClaims[PLATFORM_ROLE_CLAIM];
    expect((await h.verify(await h.sign(noneClaims))).platformRole).toBeNull();
  });

  it("keeps the URN claim key Idp emits", () => {
    // Idp builds this as config.x.jwt.claim_namespace + "platform_role", with
    // the namespace hardcoded to "urn:idp:". A mismatch here silently
    // downgrades every consumer to platform_role=null, i.e. no access.
    expect(PLATFORM_ROLE_CLAIM).toBe("urn:idp:platform_role");
    expect(LEGACY_PLATFORM_ROLE_CLAIM).toBe("https://claims.entental.com/platform_role");
  });

  it("ranks the role vocabulary owner > admin > member > viewer > none", async () => {
    const h = await harness();
    const tiers: ReadonlyArray<[PlatformRole, boolean, boolean, boolean]> = [
      // role, platformOwner, platformAdmin, platformViewer
      ["owner", true, true, true],
      ["admin", false, true, true],
      ["member", false, false, true],
      ["viewer", false, false, true],
      ["none", false, false, false],
    ];
    for (const [role, owner, admin, viewer] of tiers) {
      const p = await h.verify(await h.sign(userClaims({ [PLATFORM_ROLE_CLAIM]: role })));
      expect([role, p.platformOwner, p.platformAdmin, p.platformViewer]).toEqual([
        role,
        owner,
        admin,
        viewer,
      ]);
    }
  });

  // --- Service tokens ---------------------------------------------------

  it("discriminates service tokens structurally and throws on user-only getters", async () => {
    const h = await harness();
    const clientId = "polaris_admin_development";
    const passport = await h.verify(
      await h.sign(userClaims({ sub: clientId, client_id: clientId, scope: "revocations:read" })),
    );

    expect(passport.service).toBe(true);
    expect(passport.user).toBe(false);
    expect(passport.clientId).toBe(clientId);
    expect(passport.scopes).toEqual(["revocations:read"]);
    expect(passport.hasScope("revocations:read")).toBe(true);

    // This is the trap the admin guard must avoid: `platformRole` THROWS on a
    // service token rather than returning null, so callers must branch on
    // `user` first. See apps/control-plane-api/src/admin/platform-role.ts.
    expect(() => passport.platformRole).toThrow(NotAUserTokenError);
    expect(() => passport.platformAdmin).toThrow(NotAUserTokenError);
    expect(() => passport.email).toThrow(NotAUserTokenError);
  });

  it("treats a user token carrying a client_id as a user token", async () => {
    const h = await harness();
    // OAuth-grant user tokens carry client_id = the app but sub = the user.
    const passport = await h.verify(
      await h.sign(userClaims({ client_id: "polaris_admin_development" })),
    );
    expect(passport.service).toBe(false);
    expect(passport.platformRole).toBe("admin");
  });

  // --- Revocation seam --------------------------------------------------

  it("consults an injected revocation checker for user tokens only", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const config = idpConfig({ jwksUrl: `${ISSUER}/jwks`, issuer: ISSUER });
    const seen: string[] = [];
    const verifier = new Verifier({
      config,
      jwksClient: new StubJwksClient(config, publicKey, KID),
      revocationSubscriber: {
        isRevoked: (subject) => {
          seen.push(subject);
          return true;
        },
      },
    });
    const sign = (claims: Record<string, unknown>): Promise<string> =>
      new jose.SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: KID, typ: "at+jwt" })
        .sign(privateKey);

    await expect(verifier.verify(await sign(userClaims()))).rejects.toThrow(RevokedTokenError);
    expect(seen).toEqual(["usr_01960000000000000000000000"]);

    // Service tokens skip the lookup entirely.
    const svc = "polaris_admin_development";
    await expect(
      verifier.verify(await sign(userClaims({ sub: svc, client_id: svc }))),
    ).resolves.toBeInstanceOf(Passport);
    expect(seen).toEqual(["usr_01960000000000000000000000"]);
  });
});
