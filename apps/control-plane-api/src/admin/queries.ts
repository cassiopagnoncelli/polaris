/**
 * Read queries backing the admin pages.
 *
 * Deliberately local to this app rather than reusing `apps/polaris-cli/src/db`:
 * the CLI's read functions project for a terminal, not for a page. Its
 * `listApiKeysByProjectEnv` demands *both* a project and an environment, which
 * is the wrong shape for a per-project key panel, and the overview's counts
 * exist nowhere. A read projection diverging from the CLI's is cosmetic.
 *
 * Writes are a different matter — a mutation diverging from the CLI's is a
 * correctness bug — so those go through a shared package instead. See
 * `actions/` and the M3 extraction.
 *
 * Two rules hold everywhere in this file:
 *
 *   - **`api_keys.hash` is never selected.** Not filtered in the view: never
 *     read out of the database at all, matching what the CLI's repository
 *     layer already does. `admin-ui.test.ts` asserts the literal hash string
 *     is absent from the rendered page.
 *   - **Tables outside `@polaris/shared-db`'s `Database` are read through a
 *     typed `sql` template**, not a module augmentation. `dlq_records` is
 *     declared by `@polaris/shared-destinations`, and depending on that
 *     package here would drag the whole destination-delivery stack into a
 *     service that has no business holding it — while re-declaring the table
 *     locally would create a second augmentation that silently breaks the
 *     moment either copy is edited.
 */

import {
  type AuditEnvironment,
  listProjectConfig,
  type ProjectConfigRow,
} from "@polaris/shared-control-plane-db";
import type { Database } from "@polaris/shared-db";
import { type Kysely, sql } from "kysely";

// ---- row shapes ---------------------------------------------------------

export interface ProjectRow {
  readonly project_id: string;
  readonly display_name: string;
  readonly owner: string;
  readonly description: string;
  readonly status: string;
  readonly created_at: Date;
}

export interface SourceRow {
  readonly project_id: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly owner: string;
  readonly runtime: string;
  readonly status: string;
  readonly allowed_environments: readonly string[];
}

export interface ApiKeyRow {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly last_used_at: Date | null;
}

export interface DestinationRow {
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly instance_label: string;
  readonly status: string;
  readonly mode: string;
  readonly max_concurrency: number;
  readonly max_rps: number;
  readonly retry_policy: string;
  readonly dead_letter_threshold: number;
  readonly disabled_reason: string | null;
  readonly replay_opt_in: boolean;
  readonly replay_opt_in_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProcessorActivationRow {
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string;
  readonly environment: string;
  readonly enabled_state: string;
  readonly enabled_at: Date | null;
  readonly disabled_at: Date | null;
  readonly last_changed_by: string;
}

/**
 * A row of `processor_runs` — what actually ran, as opposed to what an
 * operator activated. Written by each processor's boot layer through
 * `@polaris/shared-processor`'s `openProcessorRun`.
 */
export interface ProcessorRunRow {
  readonly run_id: string;
  readonly processor_name: string;
  readonly processor_version: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly status: string;
  readonly events_consumed: number;
  readonly events_emitted: number;
  readonly events_failed: number;
  readonly host: string | null;
  readonly error_summary: string | null;
}

export interface AuditRow {
  readonly audit_id: string;
  readonly created_at: Date;
  readonly actor_source: string;
  readonly actor_label: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly project_id: string | null;
  readonly environment: string | null;
  readonly reason: string | null;
  readonly request_id: string | null;
  readonly before: unknown;
  readonly after: unknown;
}

/**
 * DLQ row, **metadata only**.
 *
 * `payload` (bytea) is deliberately never selected. It is the one column an
 * external party controls — it holds the raw event envelope, including the
 * producer-supplied `context.page.url` — and rendering it is a stored-XSS and
 * PII question this UI does not need to answer to be useful. `reason`,
 * `error_class`, and the vendor response are enough to triage most rows; the
 * CLI has the payload when they are not.
 */
export interface DlqRow {
  readonly dlq_id: string;
  readonly destination_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly vendor: string;
  readonly event_id: string | null;
  readonly reason: string;
  readonly error_class: string | null;
  readonly attempts: number;
  readonly created_at: Date;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
}

export interface OverviewCounts {
  readonly projects: number;
  readonly sources: number;
  readonly destinationsActive: number;
  readonly destinationsInactive: number;
  readonly apiKeysActive: number;
  readonly dlqUnresolved: number;
}

export interface AuditFilter {
  readonly actorLabel?: string | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly environment?: string | undefined;
  readonly limit: number;
}

export interface DestinationFilter {
  readonly projectId?: string | undefined;
  readonly environment?: string | undefined;
  readonly status?: string | undefined;
}

export interface ApiKeyFilter {
  readonly projectId?: string | undefined;
  readonly environment?: string | undefined;
  readonly includeRevoked: boolean;
}

export interface DlqFilter {
  readonly destinationId?: string | undefined;
  readonly vendor?: string | undefined;
  readonly includeResolved: boolean;
  readonly limit: number;
}

/**
 * Everything the pages read.
 *
 * An interface so tests inject fixtures — the same seam
 * `operatorTokenRepository` already provides for bearer auth. Without it no
 * admin page is testable without a live Postgres.
 */
export interface AdminQueries {
  counts(): Promise<OverviewCounts>;
  listProjects(): Promise<readonly ProjectRow[]>;
  findProject(projectId: string): Promise<ProjectRow | null>;
  listProjectConfig(input: {
    projectId: string;
    environment: AuditEnvironment;
  }): Promise<readonly ProjectConfigRow[]>;
  listSources(projectId?: string): Promise<readonly SourceRow[]>;
  listDestinations(filter: DestinationFilter): Promise<readonly DestinationRow[]>;
  findDestination(destinationId: string): Promise<DestinationRow | null>;
  listApiKeys(filter: ApiKeyFilter): Promise<readonly ApiKeyRow[]>;
  findApiKey(apiKeyId: string): Promise<ApiKeyRow | null>;
  listProcessorActivations(): Promise<readonly ProcessorActivationRow[]>;
  listProcessorRuns(limit: number): Promise<readonly ProcessorRunRow[]>;
  listAudit(filter: AuditFilter): Promise<readonly AuditRow[]>;
  findAudit(auditId: string): Promise<AuditRow | null>;
  listDlq(filter: DlqFilter): Promise<readonly DlqRow[]>;
  findDlq(dlqId: string): Promise<DlqRow | null>;
}

export function createKyselyAdminQueries(db: Kysely<Database>): AdminQueries {
  return {
    async counts(): Promise<OverviewCounts> {
      const [projects, sources, destinations, apiKeys, dlq] = await Promise.all([
        db
          .selectFrom("projects")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .executeTakeFirst(),
        db
          .selectFrom("sources")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .executeTakeFirst(),
        db
          .selectFrom("destinations")
          .select(["status"])
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .groupBy("status")
          .execute(),
        db
          .selectFrom("api_keys")
          .where("status", "=", "active")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .executeTakeFirst(),
        sql<{ n: string }>`
          SELECT count(*) AS n FROM dlq_records WHERE resolved_at IS NULL
        `.execute(db),
      ]);

      let active = 0;
      let inactive = 0;
      for (const row of destinations) {
        const n = Number(row.n);
        if (row.status === "active") active += n;
        else inactive += n;
      }

      return {
        projects: Number(projects?.n ?? 0),
        sources: Number(sources?.n ?? 0),
        destinationsActive: active,
        destinationsInactive: inactive,
        apiKeysActive: Number(apiKeys?.n ?? 0),
        dlqUnresolved: Number(dlq.rows[0]?.n ?? 0),
      };
    },

    async listProjects(): Promise<readonly ProjectRow[]> {
      return db
        .selectFrom("projects")
        .select(["project_id", "display_name", "owner", "description", "status", "created_at"])
        .orderBy("project_id")
        .execute();
    },

    // Delegates to the shared read rather than hand-rolling the query here,
    // so the panel and the CLI cannot disagree about what a stored value is.
    async listProjectConfig(input): Promise<readonly ProjectConfigRow[]> {
      return listProjectConfig(db, input);
    },

    async findProject(projectId: string): Promise<ProjectRow | null> {
      const row = await db
        .selectFrom("projects")
        .select(["project_id", "display_name", "owner", "description", "status", "created_at"])
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      return row ?? null;
    },

    async listSources(projectId?: string): Promise<readonly SourceRow[]> {
      let query = db
        .selectFrom("sources")
        .select([
          "project_id",
          "source_id",
          "source_type",
          "owner",
          "runtime",
          "status",
          "allowed_environments",
        ]);
      if (projectId !== undefined) query = query.where("project_id", "=", projectId);
      return query.orderBy("project_id").orderBy("source_id").execute();
    },

    async listDestinations(filter: DestinationFilter): Promise<readonly DestinationRow[]> {
      let query = db.selectFrom("destinations").select(DESTINATION_COLUMNS);
      if (filter.projectId !== undefined) query = query.where("project_id", "=", filter.projectId);
      if (filter.environment !== undefined) {
        query = query.where("environment", "=", filter.environment);
      }
      if (filter.status !== undefined) {
        query = query.where("status", "=", filter.status as never);
      }
      return query.orderBy("project_id").orderBy("environment").orderBy("instance_label").execute();
    },

    async findDestination(destinationId: string): Promise<DestinationRow | null> {
      const row = await db
        .selectFrom("destinations")
        .select(DESTINATION_COLUMNS)
        .where("destination_id", "=", destinationId)
        .executeTakeFirst();
      return row ?? null;
    },

    async listApiKeys(filter: ApiKeyFilter): Promise<readonly ApiKeyRow[]> {
      // `hash` is absent from this list on purpose — see the file header.
      let query = db
        .selectFrom("api_keys")
        .select([
          "api_key_id",
          "project_id",
          "environment",
          "source_id",
          "source_type",
          "status",
          "created_at",
          "revoked_at",
          "last_used_at",
        ]);
      if (filter.projectId !== undefined) query = query.where("project_id", "=", filter.projectId);
      if (filter.environment !== undefined) {
        query = query.where("environment", "=", filter.environment);
      }
      if (!filter.includeRevoked) query = query.where("status", "=", "active");
      return query.orderBy("created_at", "desc").execute();
    },

    async findApiKey(apiKeyId: string): Promise<ApiKeyRow | null> {
      // `hash` is absent here too — see the file header.
      const row = await db
        .selectFrom("api_keys")
        .select([
          "api_key_id",
          "project_id",
          "environment",
          "source_id",
          "source_type",
          "status",
          "created_at",
          "revoked_at",
          "last_used_at",
        ])
        .where("api_key_id", "=", apiKeyId)
        .executeTakeFirst();
      return row ?? null;
    },

    async listProcessorActivations(): Promise<readonly ProcessorActivationRow[]> {
      return db
        .selectFrom("processor_activations")
        .select([
          "processor_name",
          "processor_version",
          "project_id",
          "environment",
          "enabled_state",
          "enabled_at",
          "disabled_at",
          "last_changed_by",
        ])
        .orderBy("processor_name")
        .orderBy("processor_version")
        .orderBy("project_id")
        .execute();
    },

    async listProcessorRuns(limit: number): Promise<readonly ProcessorRunRow[]> {
      // Newest first, and `running` rows sort with the rest — a run that
      // started days ago and is still open is exactly what an operator needs
      // to see at the top of the list, not something to filter out.
      return db
        .selectFrom("processor_runs")
        .select([
          "run_id",
          "processor_name",
          "processor_version",
          "project_id",
          "environment",
          "started_at",
          "finished_at",
          "status",
          "events_consumed",
          "events_emitted",
          "events_failed",
          "host",
          "error_summary",
        ])
        .orderBy("started_at", "desc")
        .limit(limit)
        .execute();
    },

    async listAudit(filter: AuditFilter): Promise<readonly AuditRow[]> {
      let query = db.selectFrom("audit_records").select(AUDIT_COLUMNS);
      if (filter.actorLabel !== undefined)
        query = query.where("actor_label", "=", filter.actorLabel);
      if (filter.action !== undefined) query = query.where("action", "=", filter.action);
      if (filter.targetType !== undefined) {
        query = query.where("target_type", "=", filter.targetType);
      }
      if (filter.targetId !== undefined) query = query.where("target_id", "=", filter.targetId);
      if (filter.projectId !== undefined) query = query.where("project_id", "=", filter.projectId);
      if (filter.environment !== undefined) {
        query = query.where("environment", "=", filter.environment as never);
      }
      return query.orderBy("created_at", "desc").limit(filter.limit).execute();
    },

    async findAudit(auditId: string): Promise<AuditRow | null> {
      const row = await db
        .selectFrom("audit_records")
        .select(AUDIT_COLUMNS)
        .where("audit_id", "=", auditId)
        .executeTakeFirst();
      return row ?? null;
    },

    async listDlq(filter: DlqFilter): Promise<readonly DlqRow[]> {
      // `payload` is never selected — see DlqRow's doc comment.
      const conditions = [
        filter.includeResolved ? sql`TRUE` : sql`resolved_at IS NULL`,
        filter.destinationId !== undefined
          ? sql`destination_id = ${filter.destinationId}`
          : sql`TRUE`,
        filter.vendor !== undefined ? sql`vendor = ${filter.vendor}` : sql`TRUE`,
      ];
      const result = await sql<DlqRow>`
        SELECT dlq_id, destination_id, project_id, environment, vendor, event_id,
               reason, error_class, attempts, created_at, resolved_at, resolved_by
        FROM dlq_records
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY created_at DESC
        LIMIT ${filter.limit}
      `.execute(db);
      return result.rows;
    },

    async findDlq(dlqId: string): Promise<DlqRow | null> {
      const result = await sql<DlqRow>`
        SELECT dlq_id, destination_id, project_id, environment, vendor, event_id,
               reason, error_class, attempts, created_at, resolved_at, resolved_by
        FROM dlq_records
        WHERE dlq_id = ${dlqId}
      `.execute(db);
      return result.rows[0] ?? null;
    },
  };
}

// `secret_value` is absent on purpose, the same rule `api_keys.hash` follows:
// the column holds a vendor credential in plaintext, and every consumer of
// this list renders it into a page. Nothing in the panel reads it — a
// destination credential is write-only through every Polaris surface.
const DESTINATION_COLUMNS = [
  "destination_id",
  "project_id",
  "environment",
  "vendor",
  "instance_label",
  "status",
  "mode",
  "max_concurrency",
  "max_rps",
  "retry_policy",
  "dead_letter_threshold",
  "disabled_reason",
  "replay_opt_in",
  "replay_opt_in_reason",
  "created_at",
  "updated_at",
] as const;

const AUDIT_COLUMNS = [
  "audit_id",
  "created_at",
  "actor_source",
  "actor_label",
  "action",
  "target_type",
  "target_id",
  "project_id",
  "environment",
  "reason",
  "request_id",
  "before",
  "after",
] as const;
