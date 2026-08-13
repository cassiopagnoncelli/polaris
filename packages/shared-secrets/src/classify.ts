/**
 * Is a secret-resolution failure worth retrying?
 *
 * The destination runtime asked this question by assuming the answer: every
 * `secrets.resolve()` throw was recorded `failed_permanent` and published
 * straight to the DLQ. That is right for a reference nobody provisioned and
 * badly wrong for a provider that was briefly unreachable — a Vault 503, a
 * token-renewal race, a network blip during a rolling restart would each
 * destroy deliveries that a retry seconds later would have completed, and each
 * one then needs an operator to notice and replay it by hand.
 *
 * This module makes the question explicit so the runtime can branch on it.
 *
 * @see docs/implementation/project-config-plan.md §6
 */

import {
  SecretNotFoundError,
  SecretProviderError,
  SecretProviderNotConfiguredError,
  SecretReferenceParseError,
} from "./errors.js";

export type SecretFailureClass = "transient" | "permanent";

/**
 * Classify a thrown secret-resolution failure.
 *
 * Unknown errors classify **transient**, and the asymmetry behind that default
 * is the whole point. A wrong `permanent` is immediate data loss that needs a
 * human to replay. A wrong `transient` costs a bounded number of retries and
 * still reaches the DLQ once the attempt counter passes the destination's
 * `dead_letter_threshold` — the same place it would have landed, only later
 * and only after the platform gave the thing a chance to recover. Those two
 * mistakes are not close in cost, so the default goes to the cheap one.
 */
export function classifySecretFailure(err: unknown): SecretFailureClass {
  // The reference is not provisioned. Retrying cannot conjure it.
  if (err instanceof SecretNotFoundError) return "permanent";

  // This deployment has no adapter for the referenced provider — a
  // configuration error in the service, not a hiccup in the provider.
  if (err instanceof SecretProviderNotConfiguredError) return "permanent";

  // The stored reference is malformed. An operator has to fix the row.
  if (err instanceof SecretReferenceParseError) return "permanent";

  // Provider unreachable, or the auth handshake failed. The reference may be
  // perfectly good; the platform just cannot fetch it right now.
  if (err instanceof SecretProviderError) return "transient";

  return "transient";
}
