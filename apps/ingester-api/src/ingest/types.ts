import {
  type BatchAcceptedResult,
  type BatchRejectedResult,
  type BatchResponse,
  batchResponseSchema,
} from "@polaris/spec";
import { z } from "zod";

import type { AuthenticatedRequestContext } from "../auth/api-key.js";

/**
 * Request body accepted by `POST /v1/events`.
 *
 * The shape is intentionally minimal: an `events` array. The ingester
 * validates each entry's envelope and properties independently — partial
 * acceptance is non-negotiable (`04-ingestion-and-sdks.md` "Batch Failure
 * Behavior"). The top-level object is `.passthrough()` rather than
 * `.strict()` so SDKs can evolve their request envelope without forcing a
 * lockstep ingester redeploy; only the `events` array is mandatory.
 */
export const batchRequestSchema = z
  .object({
    events: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

export type BatchRequest = z.infer<typeof batchRequestSchema>;

/**
 * The handler's runtime context: trusted tuple stamped from the API key
 * plus the optional batch-level metadata. Routed handlers compose this
 * from the auth preHandler and the parsed request.
 */
export interface IngestRequestContext {
  readonly auth: AuthenticatedRequestContext;
  readonly receivedAt: Date;
  readonly requestId: string;
}

export type { BatchAcceptedResult, BatchRejectedResult, BatchResponse };
export { batchResponseSchema };
