import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { createProblemErrorHandler } from "@polaris/shared-service-bootstrap";

import {
  API_KEY_HEADER,
  AUTH_PROBLEM_CODES,
  createAuthPreHandler,
  createAuthService,
} from "../../src/auth/index.js";
import { NOT_IMPLEMENTED_AFTER_AUTH_CODE, registerEventsRoutes } from "../../src/routes/events.js";
import { InMemoryApiKeyRepository } from "../fixtures.js";

const PROBLEM_JSON = "application/problem+json; charset=utf-8";

function seedRepo(): InMemoryApiKeyRepository {
  const repo = new InMemoryApiKeyRepository();
  repo.set({
    apiKeyId: "ak_live",
    projectId: "checkout",
    environment: "production",
    sourceId: "storefront-web",
    sourceType: "web",
    hash: "argon2id-stub",
    hashAlgorithm: "argon2id",
    status: "active",
  });
  return repo;
}

async function buildAuthApp({
  repo,
  verify,
}: {
  repo: InMemoryApiKeyRepository;
  verify: (plaintext: string, hash: string, algorithm: string) => Promise<boolean>;
}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(createProblemErrorHandler());
  const authenticate = createAuthService({ repository: repo, verifyHash: verify });
  const authPreHandler = createAuthPreHandler({ authenticate });
  registerEventsRoutes(app, { authPreHandler });
  // Capture-route used to assert request.auth wiring downstream of the hook.
  app.post("/__auth_echo", { preHandler: authPreHandler }, async (req) => ({
    auth: req.auth,
  }));
  return app;
}

describe("auth preHandler on POST /v1/events", () => {
  it("returns 401 missing_api_key when the header is absent", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({
      repo,
      verify: async () => true,
    });
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toBe(PROBLEM_JSON);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.missingApiKey);
    // The repository must not be queried when no key is presented.
    expect(repo.lookupCount).toBe(0);
    await app.close();
  });

  it("returns 401 invalid_api_key when the header is malformed", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: "no-separator" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
    expect(repo.lookupCount).toBe(0);
    await app.close();
  });

  it("returns 401 invalid_api_key when the api_key_id is unknown", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: "ak_missing.secret" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
    await app.close();
  });

  it("returns 401 invalid_api_key when the key is revoked", async () => {
    const repo = new InMemoryApiKeyRepository();
    repo.set({
      apiKeyId: "ak_live",
      projectId: "checkout",
      environment: "production",
      sourceId: "storefront-web",
      sourceType: "web",
      hash: "argon2id-stub",
      hashAlgorithm: "argon2id",
      status: "revoked",
    });
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: "ak_live.secret" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
    await app.close();
  });

  it("returns 401 invalid_api_key when the hash does not match", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => false });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: "ak_live.wrong" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.invalidApiKey);
    await app.close();
  });

  it("returns 503 auth_unavailable when the repository throws", async () => {
    const repo = seedRepo();
    repo.throwOnNextLookup = new Error("postgres down");
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: "ak_live.secret" },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(AUTH_PROBLEM_CODES.authUnavailable);
    await app.close();
  });

  it("returns 501 not_implemented_after_auth on valid auth", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { events: [] },
      headers: { [API_KEY_HEADER]: "ak_live.right" },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe(NOT_IMPLEMENTED_AFTER_AUTH_CODE);
    expect(body.status).toBe(501);
    await app.close();
  });

  it("attaches request.auth with the trusted tuple from the resolved key", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => true });
    const res = await app.inject({
      method: "POST",
      url: "/__auth_echo",
      payload: {},
      headers: { [API_KEY_HEADER]: "ak_live.right" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      auth: {
        apiKeyId: string;
        projectId: string;
        environment: string;
        source: { id: string; type: string };
      };
    };
    expect(body.auth).toEqual({
      apiKeyId: "ak_live",
      projectId: "checkout",
      environment: "production",
      source: { id: "storefront-web", type: "web" },
    });
    await app.close();
  });

  it("does not echo the raw secret in any response body", async () => {
    const repo = seedRepo();
    const app = await buildAuthApp({ repo, verify: async () => false });
    const secret = "DONT-LEAK-ME-9f3a";
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: {},
      headers: { [API_KEY_HEADER]: `ak_live.${secret}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toContain(secret);
    await app.close();
  });
});
