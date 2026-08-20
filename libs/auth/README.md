# @polaris/idp

Idp access-token verification for Polaris services.

## Provenance

This package is a **vendored subset** of `@idp/jwt`, the private JWT client for
the organisation's Idp identity provider.

| | |
| --- | --- |
| Upstream | `https://github.com/cassiopagnoncelli/idp-js` (private) |
| Vendored from | `2.13.2`, commit `9b171ac` |
| Vendored files | `errors.ts`, `passport.ts`, `jwks-client.ts`, `verifier.ts`, `refresh-client.ts` |

### Why vendored rather than depended on

The upstream repository is private, and `dist/` is gitignored there with no
`prepare` script. So neither consumption path works for Polaris CI:

- **`file:../../../idp-js`** — the path does not exist on a CI runner, and the
  Polaris Docker build context cannot reach outside the repo.
- **git URL** — cloning a *private* sibling repo needs a cross-repo PAT in
  Polaris CI secrets, and `dist/` would still be absent with nothing to build it.

The sibling app `haws` uses `"@idp/jwt": "file:../idp-js"`, which is why its
Dockerfile and CI cannot build from a clean checkout — it only works on a
developer machine that happens to have both repos side by side with `idp-js`
hand-built. Polaris does not repeat that.

### What was left behind, and why

| Upstream module | Status |
| --- | --- |
| `revocation-subscriber.ts` | **Dropped.** 1062 lines needing `redis` + `amqplib`. `control-plane-api` has neither dependency, and access tokens expire in 15 minutes anyway. `Verifier` still accepts any `RevocationChecker` if this is ever wanted back. |
| `revocation-catch-up.ts`, `client-credentials-client.ts` | **Dropped.** Only meaningful alongside the revocation subscriber. |
| `express.ts` | **Dropped.** Polaris services are Fastify; the guard is hand-rolled, as `haws` does for Express. |
| `user-agent.ts` | **Dropped.** Removes the `ua-parser-js` dependency. |
| `configuration.ts` | **Replaced** by `src/config.ts`. Upstream keeps a mutable module-level singleton (`configure()` / `getConfig()`); Polaris services pass config explicitly — `docs/instructions/claude.md` forbids reading process env outside `@polaris/shared-config`. |

The result depends on `jose` alone.

### Keeping in sync

`errors.ts`, `passport.ts`, and `refresh-client.ts` are upstream's source
**unmodified except for Biome formatting** (Polaris uses a wider line limit, so
some wrapped calls became one-liners). Normalise both sides through Biome to get
a meaningful diff on an upstream bump:

```bash
scripts/idp-vendor-diff.sh ~/src/idp-js
```

That prints nothing when the vendored copies match upstream semantically.

`jwks-client.ts` and `verifier.ts` differ deliberately: they take an explicit
config object instead of reading the module singleton, and `verifier.ts` accepts
a structural `RevocationChecker` rather than importing the dropped subscriber.
Re-apply those two edits by hand on an upgrade — they are ~15 lines total.

What matters on an upstream bump is the **wire contract**, not the code:
`test/contract.test.ts` pins the claim keys, the `at+jwt` type header, the
ES256 algorithm, the audience-defaults-to-issuer rule, and the role vocabulary.
If Idp changes any of those, that test fails and tells you what moved.

## Usage

```ts
import { Verifier, type IdpConfig } from "@polaris/idp";

const verifier = new Verifier({
  config: {
    jwksUrl: "http://localhost:3011/.well-known/jwks.json",
    issuer: "http://localhost:3011",
    audience: null,          // defaults to `issuer`, matching Idp
    jwksCacheTtlMs: 3_600_000,
    clockSkewSeconds: 30,
  },
});

const passport = await verifier.verify(accessToken);
```

**Read `platform_role` through a guard, never directly.** `Passport.platformRole`
throws `NotAUserTokenError` on a client-credentials token rather than returning
`null`, so branch on `passport.user` first:

```ts
const role = passport.user ? (passport.platformRole ?? "none") : "none";
```

`apps/control-plane-api/src/admin/platform-role.ts` wraps exactly this.
