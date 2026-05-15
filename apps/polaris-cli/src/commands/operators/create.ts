/**
 * `polaris operators create --label <email>` — mutating.
 *
 * Issues a fresh operator token. Steps:
 *
 *   1. Generate a 32-byte CSPRNG secret tail and a `polaris_ot_<uuidv7>`
 *      public id.
 *   2. argon2id-hash the secret tail through `@polaris/shared-secrets`
 *      (the same primitive `keys create` uses — no second hashing library
 *      enters the workspace).
 *   3. INSERT the row with `status='active'` AND the audit row in one
 *      transaction. The audit row's `after` snapshot stores the row's
 *      metadata only (no hash, no plaintext).
 *   4. Print the on-wire token (`polaris_ot_<id>.<secret>`) on stdout
 *      EXACTLY ONCE.
 *
 * The token plaintext appears ONLY in that single stdout write. It is
 * never persisted, never logged, never re-emitted by `operators list`.
 *
 * `mutates: true` so the production-mutation gate picks this command up
 * automatically (an operator without a token cannot use this command to
 * issue themselves production credentials).
 *
 * @see docs/architecture/02-control-plane.md "Operator Identity and Audit Actor"
 * @see docs/implementation/tasks/P6-007-operator-tokens-and-mutation-gate.md
 */
import { hashSecret, POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import { v7 as uuidv7 } from "uuid";

import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  connectDb,
  type InsertOperatorTokenInput,
  insertAuditRecord,
  insertOperatorToken,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import {
  generateOperatorTokenMaterial,
  type IssuedOperatorTokenMaterial,
} from "../../operators/token-material.js";
import { renderAccordingTo } from "../../output.js";

/**
 * Snapshot persisted on the audit row's `after` column. Metadata only —
 * NEVER the `hash`, NEVER the plaintext.
 */
export interface OperatorTokenAuditSnapshot {
  readonly operator_token_id: string;
  readonly operator_label: string;
  readonly status: string;
  readonly hash_algorithm: string;
  readonly revoked_at: string | null;
}

export interface OperatorsCreateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: OperatorTokenAuditSnapshot;
}

export interface OperatorsCreateStore {
  insertWithAudit(
    input: InsertOperatorTokenInput,
    audit: OperatorsCreateAuditPayload,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface OperatorsCreateHooks {
  readonly issue?: () => IssuedOperatorTokenMaterial;
  readonly hash?: (plaintext: string) => Promise<string>;
  readonly openStore?: () => OperatorsCreateStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
}

interface OperatorsCreateArgs {
  readonly label?: string;
}

export const operatorsCreateCommand: CommandDefinition = {
  id: "operators.create",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("create")
      .description(
        "Issue a new operator token. Prints the raw token to stdout EXACTLY ONCE; only the argon2id hash is stored.",
      )
      .requiredOption(
        "--label <operator_label>",
        "Human-facing operator identity (typically an email, e.g. alice@polaris.dev).",
      )
      .action(deps.runCommand({ id: "operators.create", mutates: true }, runOperatorsCreate));
  },
};

export function buildOperatorsCreateRunner(hooks: OperatorsCreateHooks = {}) {
  const issueMaterial = hooks.issue ?? generateOperatorTokenMaterial;
  const hashFn = hooks.hash ?? hashSecret;
  const openStore = hooks.openStore ?? defaultStore;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? uuidv7;

  return async function runner(args: OperatorsCreateArgs, ctx: CommandContext): Promise<undefined> {
    const operatorLabel = validate(args);

    const store = openStore();
    try {
      const material = issueMaterial();
      const hashed = await hashFn(material.rawSecret);
      const now = nowFn();
      const auditId = generateAuditId();
      const insertInput: InsertOperatorTokenInput = {
        operator_token_id: material.operatorTokenId,
        operator_label: operatorLabel,
        hash: hashed,
        hash_algorithm: POLARIS_HASH_ALGORITHM,
      };
      const after: OperatorTokenAuditSnapshot = {
        operator_token_id: material.operatorTokenId,
        operator_label: operatorLabel,
        status: "active",
        hash_algorithm: POLARIS_HASH_ALGORITHM,
        revoked_at: null,
      };
      const auditPayload: OperatorsCreateAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: ctx.actor.label,
        occurredAt: now,
        after,
      };

      await store.insertWithAudit(insertInput, auditPayload);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "operators.create",
          operator_token_id: material.operatorTokenId,
          operator_label: operatorLabel,
          actor_source: ctx.actor.source,
          actor_label: ctx.actor.label,
          occurred_at: now.toISOString(),
        },
        "operator token issued (audit row persisted)",
      );

      emit(ctx, {
        operatorTokenId: material.operatorTokenId,
        operatorLabel,
        token: material.token,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

function defaultStore(): OperatorsCreateStore {
  const handle = connectDb({ env: process.env });
  return {
    insertWithAudit: async (input, audit) =>
      handle.db.transaction().execute(async (trx) => {
        await insertOperatorToken(trx, input);
        await insertAuditRecord(trx, {
          audit_id: audit.auditId,
          actor_source: audit.actorSource,
          actor_label: audit.actorLabel,
          action: "operators.create",
          target_type: "operator_token",
          target_id: input.operator_token_id,
          // operator tokens are cross-project; the audit row reflects that.
          project_id: null,
          environment: null,
          before: null,
          after: audit.after,
          reason: null,
          request_id: audit.auditId,
          created_at: audit.occurredAt,
        });
      }),
    close: () => handle.close(),
  };
}

const runOperatorsCreate = buildOperatorsCreateRunner();

function validate(args: OperatorsCreateArgs): string {
  const label = args.label?.trim();
  if (label === undefined || label.length === 0) {
    throw new UsageError("--label is required");
  }
  if (label.length > 256) {
    throw new UsageError("--label must be 256 characters or fewer");
  }
  return label;
}

interface EmitInput {
  readonly operatorTokenId: string;
  readonly operatorLabel: string;
  readonly token: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        operator_token_id: input.operatorTokenId,
        operator_label: input.operatorLabel,
        token: input.token,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  return [
    "polaris operator token issued",
    `  operator_token_id  ${input.operatorTokenId}`,
    `  operator_label     ${input.operatorLabel}`,
    "",
    "Raw token (shown ONCE — store it now in POLARIS_OPERATOR_TOKEN; the platform keeps only the hash):",
    `  ${input.token}`,
  ].join("\n");
}
