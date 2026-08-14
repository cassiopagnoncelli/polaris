-- migrate:up
--
-- Correct a FALSE safety claim in the profile-plane schema documentation.
--
-- `20260814000001_create_profile_plane.sql` says of the identifier table's
-- primary key:
--
--     "the constraint is also what makes concurrent find-or-create safe:
--      two workers racing to bind the same identifier resolve to one
--      winner instead of two profiles"
--
-- The first half is true and the second is not. The key guarantees that
-- one identifier points at one profile. It does NOT prevent two workers
-- from each CREATING a profile: on a brand-new identifier both find no
-- row, both insert into `profiles`, and only then does the key arbitrate
-- who owns the identifier. The loser is left holding a profile with
-- nothing pointing at it — and, because the resolver returns that id to
-- its caller, stamping the orphan onto the spine. One person, two
-- profiles, no error anywhere.
--
-- This was not theoretical. It reproduced on the first run of
-- `tests/integration/spine-profile-store.test.ts` against a real
-- PostgreSQL: two concurrent callers, two `profiles` rows, one
-- `profile_identifiers` row. The unit suites were green throughout,
-- because an in-memory twin models find-or-create as a map lookup and
-- cannot have the bug.
--
-- The fix lives in the resolver
-- (`sync/identity/resolver/v1/src/repository.ts`): a transaction-scoped
-- advisory lock per identifier, taken before the lookup, in the canonical
-- (kind, value) order. An advisory lock is taken on a VALUE rather than a
-- row, so — unlike `SELECT ... FOR UPDATE` — it exists whether or not the
-- row does, which is the entire gap.
--
-- Per db/README.md rule 8 ("run migrations forward, never edit applied
-- files"), the original comment stays as written. This migration puts the
-- correct statement where an operator will actually meet it: the database
-- catalog, visible from `\d+ profile_identifiers`. No DDL changes; the
-- schema is untouched.

COMMENT ON TABLE profile_identifiers IS
  'The resolved identity graph: one row per known identifier, answering "who is this?". '
  'PK (project_id, environment, kind, value) is the resolver hot-path read and guarantees '
  'one identifier points at one profile. It does NOT by itself make concurrent '
  'find-or-create safe — two workers seeing a brand-new identifier both create a profile '
  'and the key only arbitrates ownership afterwards, orphaning the loser. The resolver '
  'takes a per-identifier advisory lock to close that window. See '
  'sync/identity/resolver/v1/src/repository.ts and '
  'tests/integration/spine-profile-store.test.ts.';

COMMENT ON COLUMN profile_identifiers.profile_id IS
  'The person this identifier resolves to. Repointed eagerly on merge, so a read is always '
  'one lookup and merged_into is never traversed.';

-- migrate:down

COMMENT ON TABLE profile_identifiers IS NULL;
COMMENT ON COLUMN profile_identifiers.profile_id IS NULL;
