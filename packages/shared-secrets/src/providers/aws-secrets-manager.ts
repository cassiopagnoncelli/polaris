/**
 * AWS Secrets Manager adapter — RESERVED SLOT.
 *
 * Wire when needed. Provider interface contract: see env.ts; production
 * adapter contract: see vault.ts.
 *
 * Polaris reserves the `aws-secrets-manager` slot in the `SecretProvider`
 * enum so PostgreSQL columns and CLI flags accept the string on day one.
 * Resolving a reference for this provider throws
 * `SecretProviderNotConfiguredError` until an adapter is registered with
 * the `SecretResolver`. That contract is enforced by the resolver itself;
 * no code lives in this file.
 *
 * If you are wiring this slot:
 *
 *   1. Implement `class AwsSecretsManagerProvider implements SecretProviderAdapter`.
 *   2. Mirror the structure of `VaultSecretProvider`:
 *        - thin in-house HTTP client (or AWS SDK, if the saving is worth
 *          the dependency size);
 *        - cache resolved values with a TTL;
 *        - degrade to "stale cache" on outage instead of crashing the
 *          service;
 *        - never include the resolved value in error messages, logs, or
 *          cause chains.
 *   3. Extend `@polaris/shared-config` with the AWS-specific schema if the
 *      adapter needs runtime knobs.
 *   4. Add unit tests under `test/aws-secrets-manager-provider.test.ts`,
 *      including the no-secret-in-errors assertion that defends the
 *      operator-trust contract.
 *   5. Add the matching deployment doc under
 *      `docs/deployment/secret-provider-aws-secrets-manager.md`.
 *
 * @see ./env.ts — minimal adapter, the SecretProviderAdapter contract.
 * @see ./vault.ts — production adapter pattern (cache, TTL, health, redaction).
 * @see ../resolver.ts — how an unconfigured slot is handled at runtime.
 */

export {};
