-- migrate:up
--
-- Stamp the project-config version a delivery was produced under
-- (docs/implementation/project-config-plan.md §4.5). Config resolves once per
-- batch, so every row in a batch carries the same version; "what
-- configuration produced this delivery" stays answerable months later.
--
-- Nullable: services that have not migrated to the project-config store yet
-- write NULL, so this column costs nothing before the per-service cutovers
-- land.

ALTER TABLE delivery_records
  ADD COLUMN config_version bigint;

-- migrate:down

ALTER TABLE delivery_records
  DROP COLUMN config_version;
