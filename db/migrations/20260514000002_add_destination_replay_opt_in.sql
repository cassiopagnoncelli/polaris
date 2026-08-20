-- migrate:up
--
-- Add the replay opt-in surface to the `destinations` table.
--
-- Background:
--
--   Per `docs/architecture/05-processors-and-replay.md` "Replay Control Plane"
--   and `docs/architecture/06-destinations.md` "Delivery Model":
--
--     - Destination sends during replay are disabled by default.
--     - External destination delivery during replay requires explicit opt-in.
--
--   P9-001 shipped the per-message replay-suppression module
--   (`libs/delivery/destinations/src/replay-suppression.ts`) and the
--   runtime-level `allowReplay` flag. That flag is per-host: when a host
--   process is wired with `allowReplay: true`, every destination instance the
--   host serves accepts replay traffic. The host-level dial is too coarse for
--   real incident response — an operator wanting to replay into Meta CAPI
--   should NOT also enable replay traffic to GA4 by accident.
--
-- P7-004 ships the per-instance opt-in. Each `destinations` row gains:
--
--   - `replay_opt_in`        BOOLEAN NOT NULL DEFAULT false
--   - `replay_opt_in_reason` TEXT (NULL when not opted in)
--   - `replay_opt_in_at`     TIMESTAMPTZ (stamped when opt-in flipped on)
--
-- The default value is `false` so every PRE-existing destination becomes
-- opt-out at the moment the migration lands. Operators flip individual
-- destinations on via `polaris destinations enable-replay <id> --reason ...`,
-- which writes an audit row in the same transaction. Disabling reverts the
-- column to false and stamps the operator-supplied reason; the audit row
-- carries the rationale.
--
-- Hard architectural rules baked into this migration:
--
--   - The opt-in is a per-instance toggle. The schema does NOT carry a
--     "replay-enabled events" list or any other planner-semantic column —
--     planner semantics live in versioned code (P7-002). The CLI rejects
--     planner-shaped flags before the toggle reaches PostgreSQL.
--
--   - `replay_opt_in_reason` is FREE TEXT, length-capped to 1024 chars.
--     Operators supply the rationale on every enable-replay /
--     disable-replay invocation; the column carries the MOST RECENT reason
--     so `polaris destinations show` displays the operator's last
--     justification. The full audit history lives in `audit_records`.
--
--   - `replay_opt_in_at` is set on `enable-replay`; it stays NULL until the
--     first opt-in. Disable-replay does NOT clear it (operators may want to
--     see the last time replay was active); the boolean is the
--     authoritative gate.
--
--   - A CHECK constraint ties (`replay_opt_in` = TRUE) → reason IS NOT NULL,
--     so the schema refuses an opt-in row that never carried a rationale.
--
-- @see docs/implementation/tasks/P7-004-destination-replay-guardrails.md
-- @see docs/architecture/05-processors-and-replay.md "Replay Control Plane"
-- @see docs/architecture/06-destinations.md "Delivery Model"
-- @see libs/delivery/destinations/src/replay-suppression.ts

ALTER TABLE destinations
  ADD COLUMN replay_opt_in        boolean     NOT NULL DEFAULT false,
  ADD COLUMN replay_opt_in_reason text,
  ADD COLUMN replay_opt_in_at     timestamptz;

-- The CHECK uses the column-level form so it is visible in pg_constraint
-- under the table identifier the rest of the destinations CHECKs follow.
ALTER TABLE destinations
  ADD CONSTRAINT destinations_replay_opt_in_reason_when_enabled
    CHECK (
      replay_opt_in = false
      OR (replay_opt_in_reason IS NOT NULL AND length(replay_opt_in_reason) >= 1)
    );

ALTER TABLE destinations
  ADD CONSTRAINT destinations_replay_opt_in_reason_length
    CHECK (
      replay_opt_in_reason IS NULL
      OR length(replay_opt_in_reason) <= 1024
    );

-- migrate:down

ALTER TABLE destinations
  DROP CONSTRAINT IF EXISTS destinations_replay_opt_in_reason_length;

ALTER TABLE destinations
  DROP CONSTRAINT IF EXISTS destinations_replay_opt_in_reason_when_enabled;

ALTER TABLE destinations
  DROP COLUMN IF EXISTS replay_opt_in_at,
  DROP COLUMN IF EXISTS replay_opt_in_reason,
  DROP COLUMN IF EXISTS replay_opt_in;
