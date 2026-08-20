/**
 * Polaris forbidden-field policy — platform defaults.
 *
 * This file is the **code-backed source of truth** for the platform-level
 * two-tier (reject vs redact) policy described in
 * `docs/architecture/01-event-contract.md` "Forbidden-Field Policy".
 *
 * The platform defaults intentionally implement **default-capture,
 * narrow-reject**:
 *
 *   - Only the named `pii_card` and `pii_secret` fields are rejected.
 *   - The named `card_number` field is redacted (raw value replaced; the
 *     producer's first6 / last4 partials remain).
 *   - Five pattern-based detections (Luhn PAN, AWS access keys, GitHub
 *     tokens, JWTs outside identity, generic high-entropy secrets) are
 *     **redacted**, not rejected. Each emits the metric
 *     `polaris_ingest_redacted_pattern_total{project_id, environment, reason, pattern}`.
 *
 * Categories **intentionally not present** on the platform defaults:
 *
 *   - IBAN, bank account numbers
 *   - raw email addresses
 *   - raw phone numbers
 *   - personal names
 *   - IP addresses
 *   - user-agent strings
 *
 * Projects in regulated environments add these as redactions through a
 * project-specific override at
 * `definitions/policy/forbidden-fields.<project_id>.ts`. The sample override
 * in `definitions/policy/forbidden-fields.checkout.ts` demonstrates the shape.
 *
 * The actual rule tables live in `@polaris/governance/PLATFORM_DEFAULT_POLICY`.
 * This file re-exports them so the catalog directory is the place a
 * reviewer looks for the policy and so future per-edition platform
 * tweaks land here without changing the package surface.
 */

import { type ForbiddenFieldPolicy, PLATFORM_DEFAULT_POLICY } from "@polaris/governance";

/**
 * Platform-default forbidden-field policy. The ingester loads this file
 * and merges it with the optional project override identified by the
 * envelope's `project_id`.
 */
export const platformPolicy: ForbiddenFieldPolicy = PLATFORM_DEFAULT_POLICY;

export default platformPolicy;
