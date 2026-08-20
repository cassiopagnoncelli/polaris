-- migrate:up
--
-- Add `operator_token` to the allowed `audit_records.actor_source` values.
--
-- ## The problem
--
-- `actor_source` answers "how did we know who this was". The column
-- documented `declared` as "`--actor` flag / env var / OS user / git
-- identity" — i.e. self-asserted, unverified.
--
-- Nothing produces that. Every real producer of `declared` is an
-- authenticated path: the CLI's `resolveActor` returns it only after
-- parsing an operator token, finding an ACTIVE row, checking the hash
-- algorithm and verifying the secret against the argon2id hash; the
-- control-plane API returns it after bearer-token auth or an admin IdP
-- session.
--
-- So the value understated its own assurance. Reading a production audit
-- row, an operator could not tell that the actor had authenticated at
-- all — the documentation said they might merely have typed a name.
--
-- ## What this changes
--
-- The CLI's token path now records `operator_token`. `declared` keeps its
-- meaning for the API's session/bearer paths, where the admin guard's
-- `actor.source !== "declared"` rule depends on it — that rule is a
-- security branch and this migration deliberately does not disturb it.
--
-- The result is that a production mutation made through the CLI with an
-- operator token is now distinguishable in the audit trail from one made
-- through an admin session, which is the distinction an incident review
-- actually needs.
--
-- ## No backfill
--
-- Existing `declared` rows stay. An audit row records `actor_source` and
-- `actor_label` but not which credential produced them, so rewriting
-- history here would mean guessing — and guessing inside an audit table
-- is worse than a value that is merely coarse. Rows written before this
-- migration mean "authenticated, by one of the three paths"; rows after
-- it mean what they say.

ALTER TABLE audit_records
    DROP CONSTRAINT IF EXISTS audit_records_actor_source_allowed;

ALTER TABLE audit_records
    ADD CONSTRAINT audit_records_actor_source_allowed
    CHECK (actor_source IN ('declared', 'operator_token', 'cli', 'migration', 'system'));

-- migrate:down

-- Collapse the new value back into `declared`, which is what these rows
-- would have carried before this migration. Lossy in the same direction
-- the old schema was.
UPDATE audit_records SET actor_source = 'declared' WHERE actor_source = 'operator_token';

ALTER TABLE audit_records
    DROP CONSTRAINT IF EXISTS audit_records_actor_source_allowed;

ALTER TABLE audit_records
    ADD CONSTRAINT audit_records_actor_source_allowed
    CHECK (actor_source IN ('declared', 'cli', 'migration', 'system'));
