-- migrate:up
--
-- Two new `delivery_records.status` values for PLANNED non-deliveries.
--
-- Stage 4 gains a routing gate: an instance may subscribe to a subset of
-- events, filter on envelope properties, or require consent the event does
-- not carry. When the gate refuses, nothing was attempted and nothing went
-- wrong — the instance was configured not to want this event. That is a
-- different fact from every status the table can currently express, and
-- writing it as one of them loses the distinction operators most need.
--
--   skipped_filtered  the gate refused the event for this instance:
--                     unsubscribed event name, a property filter that did
--                     not match, or a consent requirement the envelope did
--                     not satisfy. `vendor_response_summary` carries which.
--
--   skipped_unmapped  the gate PASSED and the vendor has no mapper for the
--                     event. Today this is recorded as `mapped_failed` with
--                     error_class `mapping`, which is how a routine
--                     "this vendor does not care about page.viewed" has
--                     been indistinguishable from "the mapper threw" —
--                     the planned-skip-looks-like-failure defect the
--                     redesign plan lists. A dashboard counting
--                     `mapped_failed` as errors has been counting normal
--                     operation.
--
-- Both leave `error_class` NULL, deliberately. The column is for how a
-- delivery FAILED, and neither of these failed; a nullable error class is
-- what lets "was this an error?" stay a single-column question.
--
-- No backfill. Existing `mapped_failed` rows keep their status: they were
-- written under a version of the harness that could not tell the two cases
-- apart, and rewriting them would invent a distinction the data does not
-- contain. The split applies from here forward, which is also why
-- `deliverer_version` is stamped on every row.
--
-- Postgres cannot widen a CHECK in place, so the constraint is dropped and
-- recreated. Both statements are in one migration and therefore one
-- transaction: the table is never briefly unconstrained.

ALTER TABLE delivery_records
  DROP CONSTRAINT delivery_records_status_allowed;

ALTER TABLE delivery_records
  ADD CONSTRAINT delivery_records_status_allowed
    CHECK (status IN (
      'accepted',
      'delivered',
      'dropped_consent',
      'dropped_no_identity',
      'dropped_invalid',
      'skipped_filtered',
      'skipped_unmapped',
      'mapped_failed',
      'failed_retryable',
      'failed_permanent'
    ));

-- migrate:down

ALTER TABLE delivery_records
  DROP CONSTRAINT delivery_records_status_allowed;

-- The down path would fail against rows already written with the new
-- statuses, which is correct: rolling back the schema does not un-happen
-- the deliveries it recorded. Fold such rows into `mapped_failed` by hand
-- first if a rollback is genuinely wanted.
ALTER TABLE delivery_records
  ADD CONSTRAINT delivery_records_status_allowed
    CHECK (status IN (
      'accepted',
      'delivered',
      'dropped_consent',
      'dropped_no_identity',
      'dropped_invalid',
      'mapped_failed',
      'failed_retryable',
      'failed_permanent'
    ));
