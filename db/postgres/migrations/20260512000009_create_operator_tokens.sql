-- migrate:up
--
-- Create the `operator_tokens` table.
--
-- Operator tokens are personal CLI credentials. Each row represents one issued
-- token whose plaintext was shown ONCE at creation and never persisted. The
-- dispatcher consults this table at command-time: a request that carries a
-- valid (active) operator token is the `declared` actor source — the v1
-- authenticated source. Anything else (no token, revoked token, unknown
-- token) is the `cli` source and is refused for production-mutating commands
-- by the dispatcher gate.
--
-- v1 model is intentionally minimal:
--
--   - Tokens are NOT scoped per environment. A single token authorizes its
--     operator across every project / environment the operator works in.
--     Granular scopes (per project, per env, per command group) are a future
--     iteration and would land as separate columns + a join table.
--
--   - There is no permissions / role column. Having an active token means
--     "may execute production mutations on this workspace." Roles land later
--     once a concrete authorization need surfaces.
--
--   - Tokens do not auto-expire. Rotation is operator-driven through the
--     `polaris operators` CLI. A future policy may add max-age enforcement.
--
-- See:
--   - docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
--   - docs/architecture/11-production-readiness.md "Control-Plane Permissions"
--   - docs/implementation/tasks/P6-007-operator-tokens-and-mutation-gate.md
--
-- Schema rules:
--
--   - `operator_token_id` is the public lookup prefix on the wire and the
--     primary key. Format is `polaris_ot_<uuidv7>`, mirroring `polaris_ak_`
--     for api_keys. The prefix lets log scanners and secret detectors flag
--     accidental commits at a glance.
--
--   - `operator_label` is the human-facing operator identity, typically an
--     email address (e.g. `alice@polaris.dev`). Stamped onto audit rows so
--     `polaris audit list --actor alice@polaris.dev` works. Unique label
--     per token row is NOT enforced — an operator may legitimately hold
--     multiple active tokens (e.g. during a manual overlap rotation).
--
--   - `hash` is the argon2id PHC string produced by `@polaris/shared-secrets`.
--     Plaintext is NEVER stored. `hash_algorithm` is explicit so a future
--     parameter bump can land without rewriting history.
--
--   - `status` is the lifecycle toggle (`'active'` | `'revoked'`). The
--     resolver treats anything other than `'active'` as not-usable.
--
--   - `revoked_at` is stamped on the active->revoked transition. NULL while
--     the token is active. The CLI surfaces this column in
--     `polaris operators list` so the lifecycle is auditable.
--
--   - `last_used_at` is updated out-of-band by the dispatcher (per-token
--     write coalescing) so token resolution does not gate the hot path.
--     Mirrors the `api_keys.last_used_at` semantics from P2-002.
--
-- Hard rule baked into the schema:
--
--   - NO `plaintext`, `secret`, `token`, `password`, or similar column. The
--     schema has no place to store a usable credential value. The on-wire
--     `polaris_ot_<id>.<secret>` shape exists only in the single stdout
--     write inside `polaris operators create` and `polaris operators
--     rotate`; only the argon2id `hash` of the secret tail ever lands in
--     PostgreSQL.

CREATE TABLE operator_tokens (
  operator_token_id  text        PRIMARY KEY,
  operator_label     text        NOT NULL,
  hash               text        NOT NULL,
  hash_algorithm     text        NOT NULL DEFAULT 'argon2id',
  status             text        NOT NULL DEFAULT 'active',
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  CONSTRAINT operator_tokens_status_allowed
    CHECK (status IN ('active', 'revoked')),
  CONSTRAINT operator_tokens_operator_token_id_format
    CHECK (operator_token_id ~ '^polaris_ot_[A-Za-z0-9._-]+$'),
  CONSTRAINT operator_tokens_operator_label_nonempty
    CHECK (length(operator_label) >= 1 AND length(operator_label) <= 256)
);

-- Active-token-by-recent-use lookup, used by the resolver hot path and the
-- "what tokens are live?" CLI listing.
CREATE INDEX operator_tokens_status_last_used_idx
  ON operator_tokens (status, last_used_at DESC);

-- Per-operator history lookup ("show me alice's tokens, newest first").
CREATE INDEX operator_tokens_label_created_idx
  ON operator_tokens (operator_label, created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS operator_tokens_status_last_used_idx;
DROP INDEX IF EXISTS operator_tokens_label_created_idx;
DROP TABLE IF EXISTS operator_tokens;
