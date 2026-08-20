/**
 * `polaris keys create --project <id> --env <env> --source <source_id> --type web|backend`
 *
 * Mutating: issues a new API key bound to one
 * `(project_id, environment, source_id, source_type)` tuple. Steps:
 *
 *   1. Generate a 32-byte CSPRNG secret and a `polaris_ak_<uuidv7>` public id.
 *   2. argon2id-hash the secret through `@polaris/runtime-secrets`.
 *   3. INSERT the row with `status='active'` AND the audit row in one
 *      transaction.
 *   4. Print the on-wire token (`<id>.<secret>`) on stdout EXACTLY ONCE.
 *
 * The token plaintext appears ONLY in that single stdout write. It is never
 * persisted, never logged, never re-emitted by `keys list`. The audit row's
 * `after` snapshot stores the row's metadata only (no hash, no plaintext).
 *
 * `mutates: true` so the production-mutation gate from P6-007 picks it up
 * automatically.
 */

import { POLARIS_ENVIRONMENTS } from "@polaris/runtime-environments";
import { hashSecret, POLARIS_HASH_ALGORITHM } from "@polaris/runtime-secrets";
import { v7 as uuidv7 } from "uuid";
import type { CommandContext, CommandDefinition } from "../../command.js";
import {
  type AuditActorSource,
  type AuditEnvironment,
  connectDb,
  createApiKeyWithAudit,
  type InsertApiKeyInput,
} from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { generateKeyMaterial, type IssuedKeyMaterial } from "./token.js";

const SUPPORTED_SOURCE_TYPES = ["web", "backend", "mobile", "webhook", "job"] as const;
type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];

const SUPPORTED_ENVIRONMENTS = POLARIS_ENVIRONMENTS;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

/**
 * Snapshot persisted on the audit row's `after` column. Metadata only —
 * never the `hash` or the on-wire token.
 */
export interface KeyAuditSnapshot {
  readonly api_key_id: string;
  readonly project_id: string;
  readonly environment: string;
  readonly source_id: string;
  readonly source_type: string;
  readonly status: string;
  readonly hash_algorithm: string;
  readonly revoked_at: string | null;
}

export interface KeysCreateAuditPayload {
  readonly auditId: string;
  readonly actorSource: AuditActorSource;
  readonly actorLabel: string;
  readonly occurredAt: Date;
  readonly after: KeyAuditSnapshot;
  readonly projectId: string;
  readonly environment: AuditEnvironment;
}

export interface KeysCreateStore {
  insertWithAudit(input: InsertApiKeyInput, audit: KeysCreateAuditPayload): Promise<void>;
  close(): Promise<void>;
}

export interface KeysCreateHooks {
  readonly issue?: () => IssuedKeyMaterial;
  readonly hash?: (plaintext: string) => Promise<string>;
  readonly openStore?: () => KeysCreateStore;
  readonly now?: () => Date;
  readonly generateAuditId?: () => string;
  readonly actorLabel?: () => string;
}

interface KeysCreateArgs {
  readonly project?: string;
  readonly env?: string;
  readonly source?: string;
  readonly type?: string;
}

export const keysCreateCommand: CommandDefinition = {
  id: "keys.create",
  mutates: true,
  register: (parent, deps) => {
    parent
      .command("create")
      .description(
        "Issue a new API key. Prints the raw token to stdout EXACTLY ONCE; only the argon2id hash is stored.",
      )
      .requiredOption("--project <project_id>", "Project this key is bound to.")
      .requiredOption("--env <environment>", "Environment: development | staging | production.")
      .requiredOption(
        "--source <source_id>",
        "Source this key authenticates (e.g. storefront-web).",
      )
      .requiredOption(
        "--type <source_type>",
        "Source type: web | backend | mobile | webhook | job.",
      )
      .action(deps.runCommand({ id: "keys.create", mutates: true }, runKeysCreate));
  },
};

export function buildKeysCreateRunner(hooks: KeysCreateHooks = {}) {
  const issueMaterial = hooks.issue ?? generateKeyMaterial;
  const hashFn = hooks.hash ?? hashSecret;
  const nowFn = hooks.now ?? (() => new Date());
  const generateAuditId = hooks.generateAuditId ?? uuidv7;
  const actorLabelOverride = hooks.actorLabel;

  return async function runner(args: KeysCreateArgs, ctx: CommandContext): Promise<undefined> {
    const openStore = hooks.openStore ?? (() => defaultStore(ctx.env));
    const validated = validate(args);

    const store = openStore();
    try {
      const material = issueMaterial();
      const hashed = await hashFn(material.rawSecret);
      const now = nowFn();
      const auditId = generateAuditId();
      const insertInput: InsertApiKeyInput = {
        api_key_id: material.apiKeyId,
        project_id: validated.project,
        environment: validated.env,
        source_id: validated.source,
        source_type: validated.type,
        hash: hashed,
        hash_algorithm: POLARIS_HASH_ALGORITHM,
      };
      const after: KeyAuditSnapshot = {
        api_key_id: material.apiKeyId,
        project_id: validated.project,
        environment: validated.env,
        source_id: validated.source,
        source_type: validated.type,
        status: "active",
        hash_algorithm: POLARIS_HASH_ALGORITHM,
        revoked_at: null,
      };
      const auditPayload: KeysCreateAuditPayload = {
        auditId,
        actorSource: ctx.actor.source,
        actorLabel: actorLabelOverride?.() ?? ctx.actor.label,
        occurredAt: now,
        after,
        projectId: validated.project,
        environment: validated.env as AuditEnvironment,
      };

      await store.insertWithAudit(insertInput, auditPayload);

      ctx.logger.info(
        {
          audit_id: auditId,
          audit_action: "keys.create",
          api_key_id: material.apiKeyId,
          project_id: validated.project,
          environment: validated.env,
          source_id: validated.source,
          source_type: validated.type,
          occurred_at: now.toISOString(),
        },
        "api key issued (audit row persisted)",
      );

      emit(ctx, {
        apiKeyId: material.apiKeyId,
        token: material.token,
        projectId: validated.project,
        environment: validated.env,
        sourceId: validated.source,
        sourceType: validated.type,
      });
    } finally {
      await store.close();
    }
    return undefined;
  };
}

function defaultStore(env: NodeJS.ProcessEnv): KeysCreateStore {
  const handle = connectDb({ env });
  return {
    insertWithAudit: async (input, audit) => {
      await createApiKeyWithAudit(handle.db, input, {
        auditId: audit.auditId,
        actorSource: audit.actorSource,
        actorLabel: audit.actorLabel,
        occurredAt: audit.occurredAt,
        before: null,
        after: audit.after,
      });
    },
    close: () => handle.close(),
  };
}

const runKeysCreate = buildKeysCreateRunner();

interface ValidatedArgs {
  readonly project: string;
  readonly env: SupportedEnvironment;
  readonly source: string;
  readonly type: SupportedSourceType;
}

function validate(args: KeysCreateArgs): ValidatedArgs {
  const project = trim(args.project);
  const env = trim(args.env);
  const source = trim(args.source);
  const type = trim(args.type);

  if (project === undefined) {
    throw new UsageError("--project is required");
  }
  if (env === undefined) {
    throw new UsageError("--env is required");
  }
  if (source === undefined) {
    throw new UsageError("--source is required");
  }
  if (type === undefined) {
    throw new UsageError("--type is required");
  }
  if (!(SUPPORTED_ENVIRONMENTS as ReadonlyArray<string>).includes(env)) {
    throw new UsageError(
      `--env must be one of: ${SUPPORTED_ENVIRONMENTS.join(", ")} (got "${env}")`,
    );
  }
  if (!(SUPPORTED_SOURCE_TYPES as ReadonlyArray<string>).includes(type)) {
    throw new UsageError(
      `--type must be one of: ${SUPPORTED_SOURCE_TYPES.join(", ")} (got "${type}")`,
    );
  }
  return {
    project,
    env: env as SupportedEnvironment,
    source,
    type: type as SupportedSourceType,
  };
}

interface EmitInput {
  readonly apiKeyId: string;
  readonly token: string;
  readonly projectId: string;
  readonly environment: string;
  readonly sourceId: string;
  readonly sourceType: string;
}

function emit(ctx: CommandContext, input: EmitInput): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(input),
      json: {
        api_key_id: input.apiKeyId,
        project_id: input.projectId,
        environment: input.environment,
        source_id: input.sourceId,
        source_type: input.sourceType,
        token: input.token,
      },
    }),
  );
}

function renderHuman(input: EmitInput): string {
  return [
    `polaris key issued`,
    `  api_key_id  ${input.apiKeyId}`,
    `  project_id  ${input.projectId}`,
    `  environment ${input.environment}`,
    `  source_id   ${input.sourceId}`,
    `  source_type ${input.sourceType}`,
    "",
    "Raw token (shown ONCE — store it now; the platform keeps only the hash):",
    `  ${input.token}`,
  ].join("\n");
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
