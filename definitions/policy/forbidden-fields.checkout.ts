/**
 * Polaris forbidden-field policy — project override for `checkout`.
 *
 * This file is the **sample** project override demonstrating the shape
 * the ingester loads when an envelope arrives with
 * `project_id: "checkout"`. It is referenced by the policy tests and the
 * CLI `polaris policy inspect checkout` command.
 *
 * Per `docs/architecture/01-event-contract.md` "Project overrides", an
 * override file may:
 *
 *   - add fields to the reject list
 *   - add fields to the redact list (named or pattern-based)
 *   - **not** remove a platform reject entry
 *   - **not** downgrade a platform reject entry to a redact except via a
 *     `documentedExceptions` entry naming the field, reviewer, and date
 *
 * The merge logic in `@polaris/shared-policy` enforces these rules at
 * startup; this file demonstrates compliant additions.
 *
 * The `checkout` project deals with PCI-adjacent flows and contact
 * details, so its override adds:
 *
 *   - reject: `iban`               — pii_account class; the project never
 *                                    legitimately sends IBANs through
 *                                    Polaris (its data lives in a
 *                                    PCI-isolated channel)
 *   - redact: `properties.email`   — raw addresses must not be persisted
 *                                    in `raw.events`; the project will
 *                                    hash and re-emit downstream
 *   - redact: `properties.phone`   — same rationale
 *   - redact-pattern: `iban_in_text` — IBAN shape in any free-form field
 */

import type { ProjectPolicyOverride } from "@polaris/shared-policy";
import { POLICY_REASON_PII_ACCOUNT, POLICY_REASON_POLICY } from "@polaris/shared-policy";

const checkoutOverride: ProjectPolicyOverride = {
  project_id: "checkout",
  reject: [
    {
      field: "iban",
      reason: POLICY_REASON_PII_ACCOUNT,
      note: "checkout never legitimately sends IBANs through Polaris",
    },
  ],
  redactNamed: [
    {
      field: "properties.email",
      reason: POLICY_REASON_POLICY,
      note: "raw email must not persist in raw.events — downstream hashing handles activation",
    },
    {
      field: "properties.phone",
      reason: POLICY_REASON_POLICY,
      note: "raw phone must not persist in raw.events — downstream hashing handles activation",
    },
  ],
  redactPatterns: [
    {
      pattern: "iban_in_text",
      reason: POLICY_REASON_PII_ACCOUNT,
      note: "IBAN shape in any free-form field",
      test(value) {
        // SEPA IBAN: 2 letters + 2 check digits + up to 30 alnum.
        // We accept the shape with optional spaces, then strip and bound
        // the digit body. This is a heuristic — false positives surface
        // through the redacted-pattern metric without dropping the event.
        if (!/\b[A-Z]{2}[0-9]{2}[A-Z0-9 ]{11,30}\b/.test(value)) return false;
        const stripped = value.replace(/\s+/g, "");
        return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(stripped);
      },
    },
  ],
  // No documentedExceptions — this override only *adds* rules; it does
  // not attempt to downgrade or remove any platform reject. If a future
  // change tried to downgrade one, an entry would land here with the
  // exception rationale and approving reviewer.
};

export default checkoutOverride;
