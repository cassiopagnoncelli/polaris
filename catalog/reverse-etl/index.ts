/**
 * The reverse-ETL job registry.
 *
 * Every job the platform can run. Adding one means adding a module and a
 * line here — a diff a reviewer can read, rather than a directory scan
 * whose contents depend on what happens to be on disk. Same contract as
 * `catalog/traits/index.ts` and `catalog/audiences/index.ts`.
 *
 * Jobs are code and deploy-time. What a job MEANS is versioned with the
 * repository; only its schedule and enablement are runtime config.
 */

import { ltvWriteback } from "./ltv-writeback.js";
import { type ReverseEtlJob, validateReverseEtlRegistry } from "./types.js";

export const REVERSE_ETL_JOBS: readonly ReverseEtlJob[] = [ltvWriteback];

// At module load, so a duplicate key or a malformed definition fails the
// process that imports the registry rather than the run that needed it.
validateReverseEtlRegistry(REVERSE_ETL_JOBS);

/** Look one up by key, or `undefined`. */
export function findReverseEtlJob(key: string): ReverseEtlJob | undefined {
  return REVERSE_ETL_JOBS.find((job) => job.key === key);
}

export { ltvWriteback } from "./ltv-writeback.js";
export {
  REVERSE_ETL_EVENTS,
  type ReverseEtlEvent,
  type ReverseEtlJob,
  type ReverseEtlMapped,
  type ReverseEtlRow,
  reverseEtlJobSchema,
  validateReverseEtlRegistry,
} from "./types.js";
