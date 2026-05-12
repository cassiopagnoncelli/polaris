/**
 * `polaris audit show <audit_id>` — read-only.
 *
 * Returns one full audit record including the `before`/`after` JSON
 * snapshots and any operator-supplied `reason`. JSON output dumps the
 * entire row; human output prints a labeled block followed by indented JSON
 * for the snapshot columns so the form remains scannable.
 *
 * `mutates: false`. Bypasses the P6-007 production gate.
 */
import type { Command } from "commander";
import type { CommandContext, CommandDefinition } from "../../command.js";
import { type AuditRecordRow, connectDb, findAuditRecordById } from "../../db/index.js";
import { UsageError } from "../../errors.js";
import { renderAccordingTo, renderJson } from "../../output.js";

interface AuditShowArgs {
  readonly auditId: string;
}

export interface AuditShowStore {
  findById(auditId: string): Promise<AuditRecordRow | null>;
  close(): Promise<void>;
}

export interface AuditShowHooks {
  readonly openStore?: () => AuditShowStore;
}

export const auditShowCommand: CommandDefinition = {
  id: "audit.show",
  mutates: false,
  register: (parent, deps) => {
    const cmd = parent
      .command("show <audit_id>")
      .description("Show one audit record by id, including before/after snapshots.");
    cmd.action(async (auditId: string, _opts: unknown, command: Command) => {
      const wrapped = deps.runCommand<AuditShowArgs>(
        { id: "audit.show", mutates: false },
        runAuditShow,
      );
      await wrapped({ auditId }, command);
    });
  },
};

export function buildAuditShowRunner(hooks: AuditShowHooks = {}) {
  const openStore = hooks.openStore ?? defaultStore;

  return async function runner(args: AuditShowArgs, ctx: CommandContext): Promise<undefined> {
    const id = args.auditId.trim();
    if (id.length === 0) {
      throw new UsageError("audit_id is required");
    }

    const store = openStore();
    try {
      const row = await store.findById(id);
      if (row === null) {
        throw new UsageError(`audit record "${id}" not found`);
      }
      emit(ctx, row);
    } finally {
      await store.close();
    }
    return undefined;
  };
}

const runAuditShow = buildAuditShowRunner();

function defaultStore(): AuditShowStore {
  const handle = connectDb({ env: process.env });
  return {
    findById: (id) => findAuditRecordById(handle.db, id),
    close: () => handle.close(),
  };
}

function emit(ctx: CommandContext, row: AuditRecordRow): void {
  ctx.output.writeOut(
    renderAccordingTo(ctx.config.output, {
      human: renderHuman(row),
      json: row,
    }),
  );
}

function renderHuman(row: AuditRecordRow): string {
  const project = row.project_id ?? "(none)";
  const env = row.environment ?? "(none)";
  const reason = row.reason ?? "(none)";
  const requestId = row.request_id ?? "(none)";
  const lines = [
    `audit_id     ${row.audit_id}`,
    `created_at   ${row.created_at}`,
    `action       ${row.action}`,
    `actor_source ${row.actor_source}`,
    `actor_label  ${row.actor_label}`,
    `target_type  ${row.target_type}`,
    `target_id    ${row.target_id}`,
    `project_id   ${project}`,
    `environment  ${env}`,
    `reason       ${reason}`,
    `request_id   ${requestId}`,
  ];
  if (row.before !== null) {
    lines.push("before:");
    lines.push(indentJson(row.before));
  }
  if (row.after !== null) {
    lines.push("after:");
    lines.push(indentJson(row.after));
  }
  return lines.join("\n");
}

function indentJson(value: unknown): string {
  const json = renderJson(value).trimEnd();
  return json
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
