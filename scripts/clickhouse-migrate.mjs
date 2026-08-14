#!/usr/bin/env node
// Polaris ClickHouse migration runner.
//
// Applies every .sql file under sql/clickhouse/ in lexicographic order
// against a ClickHouse server, idempotently.
//
// Why this script instead of the @clickhouse/client package:
//   * The migration runner is a deployment-time concern, not a library.
//     It does not belong inside a workspace package that has a build/typecheck
//     boundary with its own dependency surface.
//   * Direct @clickhouse/client imports outside packages/shared-clickhouse/
//     are LINT-BLOCKED by scripts/lint-clickhouse-imports.mjs (architecture
//     decision in 07-clickhouse.md "Access Control"). The runner uses the
//     ClickHouse HTTP /query interface with Node's native fetch, which is
//     also what the production stack uses.
//   * Keeping the runner dependency-free lets `pnpm clickhouse:migrate`
//     work without any workspace install step — useful for ops/CI scripts
//     that bootstrap a fresh ClickHouse instance.
//
// Idempotency:
//   The SQL files use `CREATE ... IF NOT EXISTS` everywhere. ClickHouse
//   accepts re-applying these statements as no-ops. Role grants (REVOKE /
//   GRANT) are additive and idempotent by ClickHouse's grant semantics.
//   The runner therefore does not need a migrations ledger table — the
//   ClickHouse DDL itself is the ledger.
//
// Application order:
//   1. sql/clickhouse/*.sql           (top-level, lexicographic)
//   2. sql/clickhouse/projections/*.sql
//   3. sql/clickhouse/materialized-views/*.sql
//   4. sql/clickhouse/roles/*.sql
//
//   This matches docs/architecture/07-clickhouse.md and
//   sql/clickhouse/README.md "Application order". Grants run last so they
//   can reference concrete tables.
//
// Usage:
//   node scripts/clickhouse-migrate.mjs                 # uses env defaults
//   node scripts/clickhouse-migrate.mjs --dry-run       # prints actions, no I/O
//   node scripts/clickhouse-migrate.mjs --root /path    # alt sql root
//
// Env vars (all optional, sensible local/dev defaults):
//   CLICKHOUSE_URL        default http://localhost:8123
//   CLICKHOUSE_USER       default polaris
//   CLICKHOUSE_PASSWORD   default polaris
//   CLICKHOUSE_DATABASE   default polaris (database name only; the runner
//                         does not append it to the URL — sql/clickhouse/
//                         files use fully-qualified `polaris.<table>`
//                         references everywhere, and 00_database.sql
//                         creates the database itself).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_SQL_ROOT = resolve(__dirname, "..", "sql", "clickhouse");

/**
 * Where in the file tree to look for SQL, in apply order. Each entry is a
 * directory relative to the SQL root. Files inside each directory are
 * applied in lexicographic order.
 *
 * The literal "." means "the SQL root itself, top level only" — the runner
 * does not recursively descend; ordering subdirectories explicitly keeps
 * the apply order auditable.
 */
const APPLY_DIRECTORIES = [".", "projections", "materialized-views", "roles"];

const SCANNED_EXTENSIONS = new Set([".sql"]);

/**
 * Filename suffixes for `.sql` files that live under sql/clickhouse/ but
 * are NOT migrations — they're SELECT templates loaded by application
 * code (e.g. `polaris clickhouse-rebuild create` reads
 * `projections/<name>_rebuild.sql` and wraps it in an INSERT). Templates
 * contain unbound ClickHouse parameter placeholders like
 * `{partition:String}` and will fail with UNKNOWN_QUERY_PARAMETER if the
 * runner tries to execute them directly.
 *
 * Add new template-naming conventions here as they appear in the tree.
 */
const NON_MIGRATION_SUFFIXES = ["_rebuild.sql"];

// Strip SQL line comments (-- ...) and block comments (slash-star ...
// star-slash), then split the remaining text on top-level semicolons.
//
// Semicolons inside string literals (single- or double-quoted) are NOT
// statement separators — ClickHouse strings can contain ';' legitimately
// (e.g. comment = 'see; here'). The state machine below tracks string
// mode so those embedded semicolons survive.
//
// ClickHouse supports both single-quoted strings and backtick-quoted
// identifiers; backticks cannot legally contain a semicolon-as-terminator,
// so the tokenizer treats them the same as strings for safety.
/**
 * Client-side macro expansion.
 *
 * Two cases push macros onto the runner instead of the ClickHouse server:
 *
 *   1. ClickHouse 25+ no longer expands `{macro}` placeholders inside the
 *      `ENGINE = ...` clause (unquoted identifier position). The polaris
 *      schema uses `ENGINE = {replicated}MergeTree` as the local/prod swap:
 *
 *        local/dev:  {replicated} = ''           → MergeTree
 *        production: {replicated} = 'Replicated' → ReplicatedMergeTree
 *
 *   2. Even where macro expansion does fire (e.g. inside string literals),
 *      values that depend on the *operator's* viewpoint — not the
 *      ClickHouse server's — can't be modelled server-side. The engine
 *      family (`{replicated}`) is the remaining example: local runs use
 *      plain MergeTree, production uses the Replicated variants.
 *
 *      The broker list used to be the canonical case here. It is gone:
 *      ClickHouse no longer connects to the broker at all, since
 *      async/warehouse/clickhouse-sink pushes rows in.
 *
 * Other macros (e.g. `{cluster}` inside `ON CLUSTER '{cluster}'`) stay
 * in string-literal position and remain server-side.
 *
 * Macros come from environment variables, defaulting to the canonical
 * docker-compose values so a developer who runs `make docker-up && make
 * setup` with no extra env gets a working stack. Bare-metal users
 * override via `.env.local` (the Makefile loads it before `make setup`).
 *
 *   POLARIS_CLICKHOUSE_REPLICATED       default '' (local; prod = 'Replicated')
 *
 * The `kafka_brokers` macro is gone: ClickHouse no longer consumes
 * anything. `async/warehouse/clickhouse-sink` pushes rows in instead, so the
 * ingestion interface table has no broker address to substitute.
 *
 * Add new entries to CLIENT_MACROS when introducing a new client-side
 * substitution. Keep the regex `{name}` literal — these are not
 * server-side macros and do not interact with ClickHouse's parameter
 * syntax (`{name:Type}`).
 */
const CLIENT_MACROS = [{ name: "replicated", env: "POLARIS_CLICKHOUSE_REPLICATED", default: "" }];

export function expandClientMacros(sql) {
  let out = sql;
  for (const macro of CLIENT_MACROS) {
    const value = process.env[macro.env] ?? macro.default;
    out = out.replace(new RegExp(`\\{${macro.name}\\}`, "g"), value);
  }
  return out;
}

export function splitSqlStatements(sql) {
  const out = [];
  const len = sql.length;
  let buf = "";
  let i = 0;
  // mode: 'code' | 'lineComment' | 'blockComment' | 'sq' | 'dq' | 'bt'
  let mode = "code";

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (mode === "code") {
      if (ch === "-" && next === "-") {
        mode = "lineComment";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        mode = "blockComment";
        i += 2;
        continue;
      }
      if (ch === "'") {
        mode = "sq";
        buf += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "dq";
        buf += ch;
        i++;
        continue;
      }
      if (ch === "`") {
        mode = "bt";
        buf += ch;
        i++;
        continue;
      }
      if (ch === ";") {
        const trimmed = buf.trim();
        if (trimmed.length > 0) out.push(trimmed);
        buf = "";
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    if (mode === "lineComment") {
      if (ch === "\n") {
        mode = "code";
        buf += "\n";
      }
      i++;
      continue;
    }

    if (mode === "blockComment") {
      if (ch === "*" && next === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "sq" || mode === "dq" || mode === "bt") {
      const quote = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
      // Backslash escape (SQL standard treats it literally inside single
      // quotes, but ClickHouse supports `'it''s'` doubled-quote escaping
      // and `'\n'` C-style escape sequences. The tokenizer is permissive:
      // a backslash-anything pair is preserved verbatim.)
      if (ch === "\\" && i + 1 < len) {
        buf += ch + sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        // Doubled-quote inside single-quoted string is an escape, not a
        // close. Other quote types are not commonly doubled, but the
        // permissive branch keeps the runner from breaking on edge cases.
        if (mode === "sq" && next === quote) {
          buf += ch + next;
          i += 2;
          continue;
        }
        mode = "code";
        buf += ch;
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Unreachable; defensively advance.
    i++;
  }

  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);

  return out;
}

/**
 * Read every *.sql file under `root` in the order declared by
 * APPLY_DIRECTORIES. Returns an array of { relativePath, sourcePath, sql }
 * — relativePath is for log output and snapshot testing, sourcePath is
 * absolute for error messages.
 */
export function discoverMigrations(root) {
  const out = [];
  for (const dir of APPLY_DIRECTORIES) {
    const dirAbs = dir === "." ? root : join(root, dir);
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch (cause) {
      // Subdirectory may not exist yet (e.g. no projections at start of
      // the project lifecycle). Skip silently.
      if (cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => {
        const dot = name.lastIndexOf(".");
        if (dot === -1) return false;
        if (!SCANNED_EXTENSIONS.has(name.slice(dot))) return false;
        // Skip non-migration template SQL (e.g. *_rebuild.sql) — see
        // NON_MIGRATION_SUFFIXES comment.
        return !NON_MIGRATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
      })
      .sort(); // lexicographic
    for (const name of files) {
      const sourcePath = join(dirAbs, name);
      const relativePath = dir === "." ? name : join(dir, name);
      // Skip directory entries that statSync reveals aren't regular files —
      // belt-and-braces in case of symlinks pointing at directories.
      const st = statSync(sourcePath);
      if (!st.isFile()) continue;
      const raw = readFileSync(sourcePath, "utf8");
      const sql = expandClientMacros(raw);
      out.push({ relativePath, sourcePath, sql });
    }
  }
  return out;
}

/**
 * POST a single SQL statement to ClickHouse's HTTP /query endpoint.
 *
 * The HTTP interface returns 200 on success and 4xx/5xx with the
 * ClickHouse error in the response body on failure. We surface the body
 * verbatim so operators can read the exact engine error.
 *
 * `fetch` is global in Node 22+ — no library needed.
 */
async function executeStatement(client, statement) {
  const url =
    `${client.url}/?` +
    new URLSearchParams({
      // Wait for distributed DDL to complete so `ON CLUSTER` clauses are
      // synchronous from the runner's perspective. In local/dev with the
      // single-node `polaris_local` cluster this resolves instantly; in
      // production the same flag prevents the runner from declaring
      // success before the cluster catches up.
      distributed_ddl_task_timeout: "60",
      // Avoid the default which lets DDL succeed even if the table already
      // exists in some replicas — we want explicit error propagation.
    }).toString();

  const auth = "Basic " + Buffer.from(`${client.user}:${client.password}`).toString("base64");
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Authorization: auth,
    },
    body: statement,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ClickHouse responded ${resp.status} ${resp.statusText}:\n${text.trim()}`);
  }
  // Drain the body so the underlying connection can be reused.
  await resp.text();
}

/**
 * Apply every discovered migration. Returns a summary of files applied
 * and how many statements ran per file.
 */
export async function applyMigrations(input) {
  const {
    root = DEFAULT_SQL_ROOT,
    client,
    logger = defaultLogger,
    dryRun = false,
    executor = executeStatement,
  } = input;

  const migrations = discoverMigrations(root);
  if (migrations.length === 0) {
    logger.info("[clickhouse-migrate] no .sql files discovered, nothing to apply.");
    return { applied: [], totalStatements: 0 };
  }

  const applied = [];
  let totalStatements = 0;

  for (const migration of migrations) {
    const statements = splitSqlStatements(migration.sql);
    if (statements.length === 0) {
      logger.info(`[clickhouse-migrate] skip ${migration.relativePath} (no executable statements)`);
      continue;
    }
    logger.info(
      `[clickhouse-migrate] apply ${migration.relativePath} (${statements.length} statement${statements.length === 1 ? "" : "s"})`,
    );
    if (dryRun) {
      applied.push({ relativePath: migration.relativePath, statements: statements.length });
      totalStatements += statements.length;
      continue;
    }
    for (let s = 0; s < statements.length; s++) {
      const stmt = statements[s];
      try {
        await executor(client, stmt);
      } catch (cause) {
        const preview = stmt.slice(0, 200).replace(/\s+/g, " ");
        throw new Error(
          `[clickhouse-migrate] ${migration.relativePath} statement ${s + 1}/${statements.length} failed: ${cause.message}\nstatement preview: ${preview}${stmt.length > 200 ? "…" : ""}`,
        );
      }
    }
    applied.push({ relativePath: migration.relativePath, statements: statements.length });
    totalStatements += statements.length;
  }

  return { applied, totalStatements };
}

const defaultLogger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/**
 * Parse `--key=value` and `--flag` style CLI args into a flat object.
 * Unknown args are returned in `_` so the caller can decide what to do.
 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function envOr(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? resolve(args.root) : DEFAULT_SQL_ROOT;
  const dryRun = Boolean(args["dry-run"]);

  const client = {
    url: envOr("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/+$/, ""),
    user: envOr("CLICKHOUSE_USER", "polaris"),
    password: envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };

  defaultLogger.info(
    `[clickhouse-migrate] root=${root} url=${client.url} user=${client.user}${dryRun ? " (dry-run)" : ""}`,
  );

  try {
    const summary = await applyMigrations({ root, client, dryRun });
    defaultLogger.info(
      `[clickhouse-migrate] done: ${summary.applied.length} file${summary.applied.length === 1 ? "" : "s"}, ${summary.totalStatements} statement${summary.totalStatements === 1 ? "" : "s"}.`,
    );
  } catch (err) {
    defaultLogger.error(err.message);
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
