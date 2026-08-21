/**
 * Schema vocabulary for a connector's project-config declaration.
 *
 * Every destination connector exports `PROJECT_CONFIG_NAMESPACE` and a
 * `projectConfigSchema`; `scripts/project-config-schemas-generate.mjs` reads
 * both from the built entry to produce `@polaris/tenancy-config-schemas`,
 * which the admin UI's typed form and `polaris config validate` work from.
 *
 * ## Why this is not `@polaris/runtime-config`'s `positiveIntSchema`
 *
 * It was, until connectors moved out of `sync/`. A connector may import
 * `libs/spec` and its `libs/delivery` port and nothing else `@polaris/*`
 * (ADR-0007's second law, enforced by
 * `scripts/lint-import-direction.mjs`), and `@polaris/runtime-config` is
 * infrastructure — it parses the PROCESS ENVIRONMENT. Re-exporting it from
 * here would launder the edge rather than remove it, and the port would
 * acquire an infrastructure dependency that `domain-never-infrastructure`
 * forbids it anyway.
 *
 * So the definition is duplicated, and the duplication is the honest
 * outcome rather than a shortcut: the two schemas coerce identically and
 * answer to different contracts. `runtime-config`'s parses an environment
 * variable, which is a string by construction and set once at boot.
 * This one parses a value an operator stored through the control plane,
 * which arrives as whatever JSON it was written as and can change under a
 * running process. If one of the two ever needs a different bound — a
 * ceiling on a per-project timeout, say — it will need it alone.
 */

import { z } from "zod";

/**
 * Positive integer (>= 1), coerced.
 *
 * Coerced rather than strict because a stored config value is JSON an
 * operator wrote: `"5000"` and `5000` both reach here and both mean the
 * same thing to the person who typed one of them.
 */
export const positiveIntSchema = z.coerce
  .number()
  .int()
  .min(1, "must be a positive integer (>= 1)");
