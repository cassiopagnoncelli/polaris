/**
 * Masking for stored secret values.
 *
 * Polaris keeps per-project secrets — a project's own sensitive variables and
 * its destination credentials — as plaintext in the control-plane database
 * (`20260813000004_plaintext_project_secrets`). That makes every read path a
 * potential disclosure, so the read paths do not get to opt IN to safety:
 * query layers return the mask, and the two places that genuinely need
 * plaintext ask for it by name.
 *
 * The two places are:
 *
 *   1. the destination runtime, which hands the credential to a vendor client
 *      (`DelivererContext.secret`), and
 *   2. an explicit operator reveal in the admin UI or `polaris config get
 *      --reveal`.
 *
 * Everything else — list views, `show` output, exports, audit `before`/`after`
 * snapshots, delivery records, DLQ payloads, log lines — sees {@link SECRET_MASK}.
 *
 * This is the coarse, structural half of the story. The fine-grained half is
 * `Secret<T>` in `@polaris/shared-project-config`, which boxes a value the
 * runtime is actually going to use so that it still cannot be stringified by
 * accident. The two are complementary: masking stops the value reaching a
 * caller at all, boxing protects the value once a caller legitimately holds it.
 *
 * @see docs/implementation/project-config-plan.md "Secrets"
 */

/**
 * What a masked secret reads as.
 *
 * Matches `Secret.toString()` in `@polaris/shared-project-config` so operators
 * see one spelling everywhere, and so a grep for a leaked credential in logs
 * has a single negative control to search for.
 */
export const SECRET_MASK = "[redacted]";

/**
 * Replace a value with {@link SECRET_MASK} when it is flagged sensitive.
 *
 * Takes the flag rather than inferring from the value: sensitivity is a
 * property of the KEY (declared in component code, stored in
 * `project_config.is_secret`), not something recoverable by inspecting a
 * string. A heuristic here — "looks like a token" — would be wrong in both
 * directions.
 */
export function maskIfSecret(value: unknown, isSecret: boolean): unknown {
  return isSecret ? SECRET_MASK : value;
}

/**
 * Whether a value is the mask rather than real data.
 *
 * Guards write paths that round-trip a read: an admin form re-submitting a
 * masked field would otherwise store the literal string `[redacted]` as the
 * credential, and the failure would only surface as a vendor auth error much
 * later. Callers treat a masked submission as "leave unchanged".
 */
export function isMaskedSecret(value: unknown): boolean {
  return value === SECRET_MASK;
}
