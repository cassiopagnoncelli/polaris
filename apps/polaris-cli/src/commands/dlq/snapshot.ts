/**
 * Audit snapshot shape used by `polaris dlq retry` and `polaris dlq
 * mark-resolved`.
 *
 * Mirrors the operationally-relevant subset of `dlq_records`. The
 * snapshot deliberately omits the raw `payload` bytes — audit_records
 * rows stay small and operator-readable, and the canonical envelope is
 * already preserved on the `dlq_records` row itself.
 */
import type { DlqRecord } from "@polaris/delivery-destinations";

export interface DlqAuditSnapshot {
  readonly dlq_id: string;
  readonly destination_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly consumer_version: string;
  readonly normalize_version: string;
  readonly mapper_version: string;
  readonly deliverer_version: string;
  readonly attempts: number;
  readonly reason: string;
  readonly error_class: string | null;
  readonly vendor_response_code: string | null;
  readonly vendor_response_summary: string | null;
  readonly delivery_key: string | null;
  readonly source_topic: string;
  readonly source_partition: number;
  readonly source_offset: string;
  readonly published_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly resolution_note: string | null;
}

export function toAuditSnapshot(row: DlqRecord): DlqAuditSnapshot {
  return {
    dlq_id: row.dlq_id,
    destination_id: row.destination_id,
    event_id: row.event_id,
    event_name: row.event_name,
    project_id: row.project_id,
    environment: row.environment,
    vendor: row.vendor,
    consumer_version: row.consumer_version,
    normalize_version: row.normalize_version,
    mapper_version: row.mapper_version,
    deliverer_version: row.deliverer_version,
    attempts: row.attempts,
    reason: row.reason,
    error_class: row.error_class,
    vendor_response_code: row.vendor_response_code,
    vendor_response_summary: row.vendor_response_summary,
    delivery_key: row.delivery_key,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    published_at: row.published_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
  };
}
