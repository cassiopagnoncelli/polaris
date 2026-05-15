/**
 * Actor resolution: turn an env var + a token repository into a
 * {@link ResolvedActor}.
 *
 * Called once per CLI invocation, immediately before the dispatcher decides
 * whether to run the command. The resolver is intentionally infrastructure-
 * agnostic — it accepts a small repository interface so the CLI wires it to
 * Kysely + PostgreSQL while tests inject an in-memory stand-in. Same story
 * for the future control-plane API: it will hand the resolver an
 * HTTP-backed repository without changing this file.
 *
 * Resolution shape (one source per call, no fall-through):
 *
 *   1. `POLARIS_OPERATOR_TOKEN` is absent, empty, or unparseable.
 *       => `{ source: 'cli', label: 'cli' }`. Mutation gate refuses
 *          production-mutating commands.
 *   2. `POLARIS_OPERATOR_TOKEN` parses but the `operator_token_id` is
 *      unknown, the row is revoked, or the secret tail fails verification.
 *       => `{ source: 'cli', label: 'cli' }`. The dispatcher refuses
 *          production-mutating commands; the audit row records the run as
 *          `actor_source: 'cli'` so a forged-token attempt is auditable.
 *   3. `POLARIS_OPERATOR_TOKEN` parses, the row exists with
 *      `status='active'`, and the secret verifies.
 *       => `{ source: 'declared', label: row.operator_label,
 *             tokenId: row.operator_token_id }`. The mutation gate allows
 *          production-mutating commands.
 *
 * Post-resolution side effect: on a successful match we touch
 * `operator_tokens.last_used_at` so operators can audit token activity
 * through `polaris operators list`. The touch is out-of-band and
 * best-effort — a failure does NOT block the command. This mirrors the
 * `api_keys.last_used_at` coalescing pattern from P2-002.
 */
import { POLARIS_HASH_ALGORITHM, verifySecret } from "@polaris/shared-secrets";
import type { ActorSource, ResolvedActor } from "./actor.js";
import { parseOperatorToken } from "./token-format.js";

/**
 * The env-var slot the resolver reads. Distinct from `POLARIS_TOKEN`
 * (the CLI bearer slot used by the thin-client config), so a dev who
 * juggles multiple environments through `~/.polaris/config.toml` can still
 * set ONE workspace-wide operator token through this single env var.
 */
export const OPERATOR_TOKEN_ENV_VAR = "POLARIS_OPERATOR_TOKEN";

/**
 * Stable display label used when no operator token resolves. Picked to be
 * distinguishable from any real `operator_label` value (which is normally
 * an email address). The audit recorder is the user of this constant.
 */
export const CLI_FALLBACK_LABEL = "cli";

/**
 * Minimum surface the resolver needs from a row lookup. Implementations
 * (Kysely-backed CLI store, HTTP-backed future API store, in-memory test
 * stub) all conform to this shape.
 *
 * `hash_algorithm` is carried through so the verifier can refuse rows
 * written with a non-argon2id primitive on day one — the
 * `@polaris/shared-secrets` `verifySecret` helper already short-circuits
 * on algorithm mismatch, but having the column on the row lets the
 * resolver fail closed if the column is somehow missing.
 */
export interface OperatorTokenRow {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly hash: string;
  readonly hash_algorithm: string;
  readonly status: "active" | "revoked";
}

/**
 * Repository contract consumed by {@link resolveActor}. The CLI wires this
 * to a Kysely-backed implementation in
 * `apps/polaris-cli/src/operators/repository.ts`; tests inject a stub.
 *
 * `findById` MUST return `null` for unknown ids (not throw). Any other
 * error (transient DB outage etc.) bubbles up — we deliberately do not
 * swallow infrastructure failures here.
 *
 * `touchLastUsedAt` is best-effort: the caller awaits it but the resolver
 * catches and discards errors so a network glitch does not block a
 * mutation. The error surface is wide enough that swallowing keeps the
 * resolver's responsibility narrow (decide, don't audit-the-audit).
 */
export interface OperatorTokenRepository {
  findById(operatorTokenId: string): Promise<OperatorTokenRow | null>;
  touchLastUsedAt(operatorTokenId: string, at: Date): Promise<void>;
}

/**
 * Hooks accepted by {@link resolveActor}.
 *
 * `env` defaults to `process.env`. `now` defaults to `() => new Date()`.
 * `verify` defaults to the platform's argon2id verifier from
 * `@polaris/shared-secrets`; tests substitute a deterministic verifier so
 * the suite does not pay the argon2 cost.
 */
export interface ResolveActorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly repository: OperatorTokenRepository;
  readonly now?: () => Date;
  readonly verify?: (plaintext: string, hash: string, algorithm: string) => Promise<boolean>;
}

/**
 * Resolve the actor for the current command invocation.
 *
 * See the module-level doc for the three-step shape. The function never
 * throws on auth-side failures — every "could not authenticate" path
 * collapses to `{ source: 'cli', label: 'cli' }`. Only infrastructure
 * exceptions (a DB outage propagating from `findById`) escape, and they
 * surface to the dispatcher as a normal command-time error.
 */
export async function resolveActor(options: ResolveActorOptions): Promise<ResolvedActor> {
  const env = options.env ?? process.env;
  const verify = options.verify ?? verifySecret;
  const now = options.now ?? (() => new Date());

  const raw = env[OPERATOR_TOKEN_ENV_VAR];
  const parsed = parseOperatorToken(raw);
  if (parsed === null) {
    return cliFallback();
  }

  const row = await options.repository.findById(parsed.operatorTokenId);
  if (row === null) return cliFallback();
  if (row.status !== "active") return cliFallback();
  if (row.hash_algorithm !== POLARIS_HASH_ALGORITHM) return cliFallback();

  const ok = await verify(parsed.rawSecret, row.hash, row.hash_algorithm);
  if (!ok) return cliFallback();

  // Best-effort last-used touch. Failures here MUST NOT block the
  // mutation; the resolver's contract is "decide who this is", not
  // "guarantee bookkeeping completeness".
  try {
    await options.repository.touchLastUsedAt(row.operator_token_id, now());
  } catch {
    // Intentionally swallowed.
  }

  return {
    source: "declared" as ActorSource,
    label: row.operator_label,
    tokenId: row.operator_token_id,
  };
}

function cliFallback(): ResolvedActor {
  return { source: "cli", label: CLI_FALLBACK_LABEL };
}
