/**
 * Participant state, in PostgreSQL.
 *
 * The engine decides; this stores. Everything here is a query over
 * `journey_participants`, and the interesting decisions are all about
 * making the DATABASE enforce the rules rather than remembering to.
 *
 * ## Entry idempotency is the index, not the code
 *
 * `enterIfAbsent` INSERTs and lets the partial unique index refuse a
 * duplicate. It does not SELECT first: a check-then-insert has a window,
 * and the trigger it guards arrives on a partitioned stream where two
 * partitions can carry the same audience transition, a redelivery can
 * repeat one, and a replay can repeat all of them. Two concurrent
 * admissions would both pass a SELECT and both insert, and a customer
 * would walk the same welcome series twice at once.
 *
 * ## The sweep claims rows before it works them
 *
 * `claimDue` UPDATEs `wait_until = NULL` on the rows it returns, in the
 * same statement that selects them, with `FOR UPDATE SKIP LOCKED`. Two
 * sweeps running at once — a slow one overlapping the next crontab tick —
 * take disjoint sets rather than both advancing the same participant and
 * emitting the same action twice.
 *
 * Clearing `wait_until` as part of the claim is what makes it a claim: a
 * row that has been handed out is no longer due, so a crash between claim
 * and advance leaves the participant parked on its step with no wait,
 * which the next sweep will not pick up. That is a deliberate trade — a
 * lost advance is recoverable by re-entering or by an operator, while a
 * duplicated vendor action is not.
 */

import type { ParticipantRow } from "@polaris/engage-journeys";
import type { Database } from "@polaris/persistence-postgres";
import { type Kysely, sql } from "kysely";

/**
 * A participant's position is `@polaris/engage-journeys`' shape, not this
 * table's. The row is what the machine reasons about; the columns below
 * are how it happens to be stored, and only this file should care about
 * the difference.
 */
export type { ParticipantRow };

export interface EnterInput {
  readonly id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly journey: string;
  readonly journey_version: number;
  readonly profile_id: string;
  readonly step_id: string;
}

export interface JourneyRepository {
  /**
   * Admit a profile, or report that it is already participating.
   *
   * Returns the row on success and `"already_participating"` when the
   * unique index refused it — which is the normal, expected outcome for a
   * redelivered trigger, not an error.
   */
  enterIfAbsent(input: EnterInput): Promise<ParticipantRow | "already_participating">;

  /** When this profile last completed this journey, for the re-entry policy. */
  lastExitedAt(input: {
    readonly project_id: string;
    readonly environment: string;
    readonly journey: string;
    readonly profile_id: string;
  }): Promise<Date | null>;

  /** Claim due waits for this sweep. See the header on why claiming clears them. */
  claimDue(input: {
    readonly environment: string;
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly ParticipantRow[]>;

  /** Move a participant to a step, optionally parking it on a wait. */
  moveTo(input: {
    readonly id: string;
    readonly step_id: string;
    readonly wait_until: Date | null;
  }): Promise<void>;

  /** End a participation. */
  exit(input: { readonly id: string; readonly reason: string; readonly at: Date }): Promise<void>;

  /**
   * Exit every active participation of a profile that lost a merge.
   *
   * Not transferred to the winner: the winner may already be
   * participating, and the unique index would refuse the transfer — but
   * more importantly a half-walked graph from another identity is not a
   * state the winner ever qualified for. It enters on its own merits at
   * the next trigger.
   */
  exitAllForProfile(input: {
    readonly project_id: string;
    readonly environment: string;
    readonly profile_id: string;
    readonly reason: string;
    readonly at: Date;
  }): Promise<readonly ParticipantRow[]>;
}

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === UNIQUE_VIOLATION;
}

export function createKyselyJourneyRepository(db: Kysely<Database>): JourneyRepository {
  return {
    async enterIfAbsent(input): Promise<ParticipantRow | "already_participating"> {
      try {
        const row = await db
          .insertInto("journey_participants")
          .values({
            id: input.id,
            project_id: input.project_id,
            environment: input.environment,
            journey: input.journey,
            journey_version: input.journey_version,
            profile_id: input.profile_id,
            step_id: input.step_id,
            wait_until: null,
          })
          .returning([
            "id",
            "project_id",
            "environment",
            "journey",
            "journey_version",
            "profile_id",
            "step_id",
            "wait_until",
          ])
          .executeTakeFirstOrThrow();
        return row as ParticipantRow;
      } catch (err) {
        // The expected outcome for a redelivered trigger. Distinguished by
        // the constraint rather than by a prior SELECT, so two concurrent
        // admissions cannot both win.
        if (isUniqueViolation(err)) return "already_participating";
        throw err;
      }
    },

    async lastExitedAt(input): Promise<Date | null> {
      const row = await db
        .selectFrom("journey_participants")
        .select("exited_at")
        .where("project_id", "=", input.project_id)
        .where("environment", "=", input.environment)
        .where("journey", "=", input.journey)
        .where("profile_id", "=", input.profile_id)
        .where("exited_at", "is not", null)
        .orderBy("exited_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return (row?.exited_at as Date | null | undefined) ?? null;
    },

    async claimDue(input): Promise<readonly ParticipantRow[]> {
      // Select and claim in one statement. `SKIP LOCKED` is what lets a
      // slow sweep overlap the next crontab tick without both advancing
      // the same participant and emitting one action twice.
      const result = await sql<ParticipantRow>`
        UPDATE journey_participants
        SET wait_until = NULL, updated_at = now()
        WHERE id IN (
          SELECT id FROM journey_participants
          WHERE environment = ${input.environment}
            AND exited_at IS NULL
            AND wait_until IS NOT NULL
            AND wait_until <= ${input.now}
          ORDER BY wait_until
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, project_id, environment, journey, journey_version,
                  profile_id, step_id, wait_until
      `.execute(db);
      return result.rows;
    },

    async moveTo(input): Promise<void> {
      await db
        .updateTable("journey_participants")
        .set({
          step_id: input.step_id,
          wait_until: input.wait_until,
          updated_at: sql`now()`,
        })
        .where("id", "=", input.id)
        .where("exited_at", "is", null)
        .execute();
    },

    async exit(input): Promise<void> {
      await db
        .updateTable("journey_participants")
        .set({
          exited_at: input.at,
          exit_reason: input.reason,
          // An exited participant is not waiting for anything; the table's
          // CHECK enforces it, and clearing here is what satisfies it.
          wait_until: null,
          updated_at: sql`now()`,
        })
        .where("id", "=", input.id)
        .where("exited_at", "is", null)
        .execute();
    },

    async exitAllForProfile(input): Promise<readonly ParticipantRow[]> {
      const rows = await db
        .updateTable("journey_participants")
        .set({
          exited_at: input.at,
          exit_reason: input.reason,
          wait_until: null,
          updated_at: sql`now()`,
        })
        .where("project_id", "=", input.project_id)
        .where("environment", "=", input.environment)
        .where("profile_id", "=", input.profile_id)
        .where("exited_at", "is", null)
        .returning([
          "id",
          "project_id",
          "environment",
          "journey",
          "journey_version",
          "profile_id",
          "step_id",
          "wait_until",
        ])
        .execute();
      return rows as ParticipantRow[];
    },
  };
}
