/**
 * RFC 7807 Problem Details for Polaris HTTP services.
 *
 * Polaris services use `application/problem+json` for request-level HTTP
 * failures (per `docs/architecture/09-engineering-standards.md` "HTTP Error
 * Contract"). This module exports:
 *
 *   - the canonical body shape (`ProblemBody`)
 *   - a body factory (`createProblem`) and named helpers (`commonProblems`)
 *   - a throwable `ProblemError` class that Fastify route handlers throw
 *   - the `application/problem+json` MIME constant (`PROBLEM_CONTENT_TYPE`)
 *
 * Per-event ingestion failures (per-event reason codes inside a batch
 * response) live in `packages/shared-schemas/` and are a separate contract.
 */

export { isProblemError, ProblemError } from "./error.js";
export { commonProblems, createProblem, PROBLEM_CONTENT_TYPE } from "./problem.js";
export {
  COMMON_PROBLEM_CODES,
  type CommonProblemCode,
  DEFAULT_PROBLEM_TYPE_BASE,
  type ProblemBody,
  type ProblemOptions,
} from "./types.js";
