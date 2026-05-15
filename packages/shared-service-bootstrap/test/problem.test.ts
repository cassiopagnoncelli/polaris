import { describe, expect, it } from "vitest";

import {
  COMMON_PROBLEM_CODES,
  commonProblems,
  createProblem,
  DEFAULT_PROBLEM_TYPE_BASE,
  isProblemError,
  PROBLEM_CONTENT_TYPE,
  ProblemError,
} from "../src/index.js";

describe("createProblem", () => {
  it("builds the canonical RFC 7807 body shape", () => {
    const body = createProblem({
      status: 401,
      code: "invalid_api_key",
      detail: "The provided API key is invalid or revoked.",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    });
    expect(body).toEqual({
      type: "https://docs.polaris/errors/invalid_api_key",
      title: "Unauthorized",
      status: 401,
      code: "invalid_api_key",
      detail: "The provided API key is invalid or revoked.",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    });
  });

  it("matches the example from the engineering standards doc", () => {
    const body = createProblem({
      status: 401,
      code: "invalid_api_key",
      title: "Invalid API key",
      detail: "The provided API key is invalid or revoked.",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    });
    expect(body.type).toBe("https://docs.polaris/errors/invalid_api_key");
    expect(body.title).toBe("Invalid API key");
    expect(body.status).toBe(401);
    expect(body.code).toBe("invalid_api_key");
    expect(body.detail).toBe("The provided API key is invalid or revoked.");
    expect(body.request_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
  });

  it("derives `type` from the configured base when no override is given", () => {
    const body = createProblem({
      status: 429,
      code: "rate_limited",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    });
    expect(body.type).toBe(`${DEFAULT_PROBLEM_TYPE_BASE}rate_limited`);
  });

  it("respects an explicit `type` override", () => {
    const body = createProblem({
      status: 429,
      code: "rate_limited",
      type: "https://example.com/errors/rate-limited",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
    });
    expect(body.type).toBe("https://example.com/errors/rate-limited");
  });

  it("merges extension members but never overwrites canonical fields", () => {
    const body = createProblem({
      status: 400,
      code: "invalid_request",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      extensions: {
        // These MUST NOT replace the canonical values.
        status: 999,
        code: "spoofed",
        request_id: "spoofed",
        // This MUST appear on the wire.
        validation: [{ path: "body.event", message: "required" }],
      },
    });
    expect(body.status).toBe(400);
    expect(body.code).toBe("invalid_request");
    expect(body.request_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(body["validation"]).toEqual([{ path: "body.event", message: "required" }]);
  });

  it("falls back to the standard HTTP status text for `title`", () => {
    expect(createProblem({ status: 503, code: "service_unavailable", request_id: "r" }).title).toBe(
      "Service Unavailable",
    );
    expect(createProblem({ status: 404, code: "not_found", request_id: "r" }).title).toBe(
      "Not Found",
    );
  });

  it("serialises to JSON without losing the canonical keys", () => {
    const body = createProblem({
      status: 400,
      code: "invalid_request",
      detail: "missing required field `event`",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      extensions: { hint: "see docs/architecture/01-event-contract.md" },
    });
    const json = JSON.parse(JSON.stringify(body));
    expect(json).toEqual({
      type: "https://docs.polaris/errors/invalid_request",
      title: "Bad Request",
      status: 400,
      code: "invalid_request",
      detail: "missing required field `event`",
      request_id: "018f1b9e-7b50-7b12-9a2e-0e2f88d8f551",
      hint: "see docs/architecture/01-event-contract.md",
    });
  });

  it("rejects empty request_id values so the request scope is never silently lost", () => {
    expect(() => createProblem({ status: 400, code: "invalid_request", request_id: "" })).toThrow(
      /request_id/,
    );
    expect(() =>
      createProblem({ status: 400, code: "invalid_request", request_id: "   " }),
    ).toThrow(/request_id/);
  });

  it("freezes the resulting body so handlers cannot mutate it before serialisation", () => {
    const body = createProblem({
      status: 400,
      code: "invalid_request",
      request_id: "r",
    });
    expect(Object.isFrozen(body)).toBe(true);
  });
});

describe("commonProblems", () => {
  it("uses the catalog code for each helper", () => {
    expect(commonProblems.invalidApiKey("r").code).toBe(COMMON_PROBLEM_CODES.invalidApiKey);
    expect(commonProblems.missingApiKey("r").code).toBe(COMMON_PROBLEM_CODES.missingApiKey);
    expect(commonProblems.forbidden("r").code).toBe(COMMON_PROBLEM_CODES.forbidden);
    expect(commonProblems.notFound("r").code).toBe(COMMON_PROBLEM_CODES.notFound);
    expect(commonProblems.rateLimited("r").code).toBe(COMMON_PROBLEM_CODES.rateLimited);
    expect(commonProblems.internalError("r").code).toBe(COMMON_PROBLEM_CODES.internalError);
  });

  it("attaches details and extensions where supplied", () => {
    const body = commonProblems.rateLimited("r", "slow down", { retry_after: 30 });
    expect(body.detail).toBe("slow down");
    expect(body["retry_after"]).toBe(30);
  });

  it("emits the right HTTP status for each helper", () => {
    expect(commonProblems.invalidRequest("r").status).toBe(400);
    expect(commonProblems.missingApiKey("r").status).toBe(401);
    expect(commonProblems.invalidApiKey("r").status).toBe(401);
    expect(commonProblems.forbidden("r").status).toBe(403);
    expect(commonProblems.notFound("r").status).toBe(404);
    expect(commonProblems.methodNotAllowed("r").status).toBe(405);
    expect(commonProblems.requestTimeout("r").status).toBe(408);
    expect(commonProblems.payloadTooLarge("r").status).toBe(413);
    expect(commonProblems.unsupportedMediaType("r").status).toBe(415);
    expect(commonProblems.rateLimited("r").status).toBe(429);
    expect(commonProblems.internalError("r").status).toBe(500);
    expect(commonProblems.serviceUnavailable("r").status).toBe(503);
  });
});

describe("ProblemError", () => {
  it("captures the supplied options for the wire body", () => {
    const err = new ProblemError({
      status: 401,
      code: "invalid_api_key",
      detail: "The provided API key is invalid or revoked.",
    });
    expect(isProblemError(err)).toBe(true);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
    expect(err.message).toBe("The provided API key is invalid or revoked.");
  });

  it("falls back to status text when no detail/title is provided", () => {
    const err = new ProblemError({ status: 503, code: "service_unavailable" });
    expect(err.message).toBe("Service Unavailable");
    expect(err.title).toBe("Service Unavailable");
  });

  it("toBody fills request_id from the request scope when not pre-populated", () => {
    const err = new ProblemError({
      status: 400,
      code: "invalid_request",
      detail: "missing required field `event`",
    });
    const body = err.toBody("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(body.request_id).toBe("018f1b9e-7b50-7b12-9a2e-0e2f88d8f551");
    expect(body.type).toBe("https://docs.polaris/errors/invalid_request");
    expect(body.status).toBe(400);
    expect(body.code).toBe("invalid_request");
    expect(body.detail).toBe("missing required field `event`");
  });

  it("toBody preserves an explicitly-supplied request_id over the scope value", () => {
    const err = new ProblemError({
      status: 400,
      code: "invalid_request",
      request_id: "captured-at-throw-site",
    });
    const body = err.toBody("from-handler");
    expect(body.request_id).toBe("captured-at-throw-site");
  });

  it("toBody freezes the result so it cannot be mutated before send", () => {
    const err = new ProblemError({ status: 400, code: "invalid_request" });
    const body = err.toBody("r");
    expect(Object.isFrozen(body)).toBe(true);
  });

  it("toBody includes extensions but skips reserved keys", () => {
    const err = new ProblemError({
      status: 400,
      code: "invalid_request",
      extensions: {
        validation: [{ path: "body.event", message: "required" }],
        // Reserved field — must be ignored.
        status: 999,
      },
    });
    const body = err.toBody("r");
    expect(body.status).toBe(400);
    expect(body["validation"]).toEqual([{ path: "body.event", message: "required" }]);
  });

  it("retains the cause pointer for operator triage without serialising it", () => {
    const cause = new Error("upstream timeout");
    const err = new ProblemError({
      status: 503,
      code: "service_unavailable",
      cause,
    });
    expect(err.cause).toBe(cause);
    const body = err.toBody("r");
    // Cause is never on the wire.
    expect("cause" in body).toBe(false);
  });
});

describe("PROBLEM_CONTENT_TYPE", () => {
  it("is the canonical RFC 7807 MIME type", () => {
    expect(PROBLEM_CONTENT_TYPE).toBe("application/problem+json");
  });
});
