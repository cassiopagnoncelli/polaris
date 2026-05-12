/**
 * `polaris keys create --project <id> --env <env> --source <source_id> --type web|backend`
 *
 * Mutating: issues a new API key bound to one
 * `(project_id, environment, source_id, source_type)` tuple. Steps:
 *
 *   1. Generate a 32-byte CSPRNG secret and a `polaris_ak_<uuidv7>` public id.
 *   2. argon2id-hash the secret through `@polaris/shared-secrets`.
 *   3. Insert the row with `status='active'`.
 *   4. Print the on-wire token (`<id>.<secret>`) on stdout EXACTLY ONCE.
 *
 * The token plaintext appears ONLY in that single stdout write. It is never
 * persisted, never logged, never re-emitted by `keys list`.
 *
 * `mutates: true` so the production-mutation gate from P6-007 picks it up
 * automatically.
 */
import { hashSecret, POLARIS_HASH_ALGORITHM } from "@polaris/shared-secrets";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { connectDb, insertApiKey, type InsertApiKeyInput } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo } from "../../output.js";
import { generateKeyMaterial, type IssuedKeyMaterial } from "./token.js";

/**
 * Closed set of source types accepted by the `--type` flag.
 *
 * Mirrors the closed CHECK constraint on `sources.source_type` in the
 * migrations. The task card specifies `web|backend` for v1; `webhook` /
 * `job` / `mobile` are platform-recognised future slots — we accept the same
 * set the migration accepts so a future task can extend the CLI without
 * dropping data.
 *
 * @see packages/shared-db/src/database.ts SourceType
 */
const SUPPORTED_SOURCE_TYPES = ["web", "backend", "mobile", "webhook", "job"] as const;
type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];

const SUPPORTED_ENVIRONMENTS = ["development", "staging", "production"] as const;
type SupportedEnvironment = (typeof SUPPORTED_ENVIRONMENTS)[number];

/**
 * Persistence surface used by `keys create`. Production wires this to
 * `insertApiKey` over a Kysely client; tests inject an in-memory recorder.
 */
export interface KeysCreateStore {
  insert(input: InsertApiKeyInput): Promise<void>;
  close(): Promise<void>;
}

/**
 * Hook surface used by tests to drive the issuance pipeline without
 * generating real entropy, computing a real hash, or touching PostgreSQL.
 * Production calls use the defaults.
 */
export interface KeysCreateHooks {
  readonly issue?: () => IssuedKeyMaterial;
  readonly hash?: (plaintext: string) => Promise<string>;
  readonly openStore?: () => KeysCreateStore;
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

/**
 * Build a `keys create` runner with overridable hooks. Tests use this to
 * inject deterministic ids/secrets and a fake hash function so the suite
 * does not pay the argon2 cost.
 */
export function buildKeysCreateRunner(hooks: KeysCreateHooks = {}) {
  const issueMaterial = hooks.issue ?? generateKeyMaterial;
  const hashFn = hooks.hash ?? hashSecret;
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: KeysCreateArgs, ctx: CommandContext): Promise<undefined> {
    const validated = validate(args);

    const store = openStore();
    try {
      const material = issueMaterial();
      const hashed = await hashFn(material.rawSecret);
      await store.insert({
        api_key_id: material.apiKeyId,
        project_id: validated.project,
        environment: validated.env,
        source_id: validated.source,
        source_type: validated.type,
        hash: hashed,
        hash_algorithm: POLARIS_HASH_ALGORITHM,
      });

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

function defaultStore(): KeysCreateStore {
  const handle = connectDb({ env: process.env });
  return {
    insert: (input) => insertApiKey(handle.db, input),
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
        // `token` is the on-wire string `<id>.<secret>`. It appears ONLY in
        // this one stdout write; nothing else in the CLI surfaces it.
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
