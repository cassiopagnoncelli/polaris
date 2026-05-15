#!/usr/bin/env node
// Polaris ClickHouse local-stack bootstrap.
//
// Wraps `scripts/clickhouse-migrate.mjs` for the local/dev case. The phases
// run in order against the local ClickHouse server:
//
//   phase 0 (server config): ensure the polaris macros, polaris_local
//     cluster, and a writeable user-directory access storage are loaded.
//     Docker compose ships these via the cluster.xml / macros.xml mount
//     plus CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1. Bare-metal installs do
//     not, so this script writes polaris-{macros,cluster,access}.xml into
//     the running server's discovered config.d/ directory and issues
//     SYSTEM RELOAD CONFIG. Idempotent — files are only written when the
//     corresponding feature is missing.
//   phase 1 (polaris user): CREATE USER polaris from the `default`
//     superuser when polaris cannot authenticate. Grants ALL with grant
//     option so phase 3 can apply role DDL.
//   phase 2 (schema): apply the canonical DDL under sql/clickhouse/.
//   phase 3 (local users): apply infra/clickhouse/init/ to create the
//     `polaris_service` / `polaris_operator` users used by service profiles.
//
// Production does NOT use this script — it applies only sql/clickhouse/.
// Local user provisioning in production comes from the secret provider
// (P11-004), not from a checked-in SQL file with hard-coded passwords.
//
// Usage:
//   node scripts/clickhouse-bootstrap-local.mjs                 # apply all
//   node scripts/clickhouse-bootstrap-local.mjs --dry-run       # plan only
//
// Env vars same as scripts/clickhouse-migrate.mjs, plus:
//   CLICKHOUSE_ADMIN_USER       default 'default'  (phases 0 and 1)
//   CLICKHOUSE_ADMIN_PASSWORD   default ''         (phases 0 and 1)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations, parseArgs } from "./clickhouse-migrate.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SQL_ROOT = resolve(REPO_ROOT, "sql", "clickhouse");
const LOCAL_INIT_ROOT = resolve(REPO_ROOT, "infra", "clickhouse", "init");

function envOr(key, fallback) {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

const logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

function basicAuth(user, password) {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

async function probe(url, user, password) {
  try {
    const resp = await fetch(`${url}/?query=${encodeURIComponent("SELECT 1")}`, {
      headers: { Authorization: basicAuth(user, password) },
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `${resp.status} ${text.trim()}` };
    }
    await resp.text();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function execAs(url, user, password, statement) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Authorization: basicAuth(user, password),
    },
    body: statement,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[clickhouse-bootstrap-local] admin statement failed (${resp.status}): ${text.trim()}\nstatement: ${statement}`,
    );
  }
  await resp.text();
}

async function queryAs(url, user, password, sql) {
  const resp = await fetch(`${url}/?query=${encodeURIComponent(sql)}`, {
    headers: { Authorization: basicAuth(user, password) },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `[clickhouse-bootstrap-local] query failed (${resp.status}): ${text.trim()}\nsql: ${sql}`,
    );
  }
  return (await resp.text()).trim();
}

function safeIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `[clickhouse-bootstrap-local] refusing to use unsafe identifier: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// On bare-metal installs, the default config ships only the read-only
// users_xml access storage and no polaris cluster/macros. Auto-install a
// config.d overlay so the rest of the bootstrap can proceed. Idempotent:
// only writes files that are missing or differ.
async function ensureLocalServerConfig({ url, adminUser, adminPassword, dryRun }) {
  logger.info("[clickhouse-bootstrap-local] phase=server-config-check");

  const macroRow = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT substitution FROM system.macros WHERE macro = 'cluster' FORMAT TabSeparated",
  );
  const clusterRow = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT cluster FROM system.clusters WHERE cluster = 'polaris_local' FORMAT TabSeparated",
  );
  const writeableStorageRow = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT name FROM system.user_directories WHERE type = 'local_directory' FORMAT TabSeparated",
  );

  const needsMacros = macroRow === "";
  const needsCluster = clusterRow === "";
  const needsWriteableStorage = writeableStorageRow === "";

  if (!needsMacros && !needsCluster && !needsWriteableStorage) {
    logger.info(
      "[clickhouse-bootstrap-local] server config OK (macros, cluster, writeable user storage all present)",
    );
    return;
  }

  logger.info(
    `[clickhouse-bootstrap-local] missing: ${[
      needsMacros && "macros",
      needsCluster && "cluster",
      needsWriteableStorage && "writeable-user-storage",
    ]
      .filter(Boolean)
      .join(", ")}`,
  );

  // Discover the config.d/ directory by parsing the users_xml storage path.
  // TabSeparatedRaw avoids TSV's outer backslash-escape so JSON.parse sees
  // the JSON the server actually emitted.
  const usersXmlRow = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT params FROM system.user_directories WHERE type = 'users_xml' FORMAT TabSeparatedRaw",
  );
  let configXmlPath;
  try {
    configXmlPath = JSON.parse(usersXmlRow).path;
  } catch (err) {
    throw new Error(
      `[clickhouse-bootstrap-local] could not parse users_xml params to find config path: ${err.message}\nparams: ${usersXmlRow}`,
    );
  }
  const configDir = dirname(configXmlPath);
  const configDDir = resolve(configDir, "config.d");

  // The local_directory access storage path needs a writeable filesystem
  // location. Derive it from system.server_settings 'path' (data dir).
  const dataPath = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT value FROM system.server_settings WHERE name = 'path' FORMAT TabSeparated",
  );
  const accessDir = resolve(dataPath, "access");

  if (dryRun) {
    logger.info(
      `[clickhouse-bootstrap-local] dry-run: would write config.d files into ${configDDir} and create ${accessDir}`,
    );
    return;
  }

  if (!existsSync(configDDir)) {
    mkdirSync(configDDir, { recursive: true });
    logger.info(`[clickhouse-bootstrap-local] created ${configDDir}`);
  }
  if (!existsSync(accessDir)) {
    mkdirSync(accessDir, { recursive: true });
    logger.info(`[clickhouse-bootstrap-local] created ${accessDir}`);
  }

  // The macros file is install-agnostic — same content as the docker mount.
  writeFileSync(
    resolve(configDDir, "polaris-macros.xml"),
    `<!-- Generated by scripts/clickhouse-bootstrap-local.mjs. Polaris local macros. -->
<clickhouse>
  <macros>
    <replicated></replicated>
    <cluster>polaris_local</cluster>
    <shard>01</shard>
    <replica>local</replica>
  </macros>
</clickhouse>
`,
  );

  // Bare-metal cluster definition uses 127.0.0.1 (docker version uses the
  // service name 'clickhouse' which doesn't resolve outside the compose net).
  const tcpPortRow = await queryAs(
    url,
    adminUser,
    adminPassword,
    "SELECT value FROM system.server_settings WHERE name = 'tcp_port' FORMAT TabSeparated",
  );
  const tcpPort = tcpPortRow || "9000";
  writeFileSync(
    resolve(configDDir, "polaris-cluster.xml"),
    `<!-- Generated by scripts/clickhouse-bootstrap-local.mjs. Polaris single-node cluster. -->
<clickhouse>
  <remote_servers>
    <polaris_local>
      <shard>
        <internal_replication>false</internal_replication>
        <replica>
          <host>127.0.0.1</host>
          <port>${tcpPort}</port>
        </replica>
      </shard>
    </polaris_local>
  </remote_servers>
</clickhouse>
`,
  );

  // Writeable access storage so the bootstrap can CREATE USER/ROLE at runtime.
  // The docker image enables this implicitly via CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT;
  // we have to declare it explicitly here.
  writeFileSync(
    resolve(configDDir, "polaris-access.xml"),
    `<!-- Generated by scripts/clickhouse-bootstrap-local.mjs. Polaris writeable user storage. -->
<clickhouse>
  <user_directories>
    <local_directory>
      <path>${accessDir}/</path>
    </local_directory>
  </user_directories>
</clickhouse>
`,
  );

  logger.info(`[clickhouse-bootstrap-local] installed config.d files into ${configDDir}`);

  // Reload config so the new files take effect.
  await execAs(url, adminUser, adminPassword, "SYSTEM RELOAD CONFIG");
  logger.info("[clickhouse-bootstrap-local] issued SYSTEM RELOAD CONFIG");

  // Re-probe so we fail loudly if reload didn't pick everything up
  // (some user_directories changes can require a server restart).
  const stillMissing = [];
  if (
    (await queryAs(
      url,
      adminUser,
      adminPassword,
      "SELECT substitution FROM system.macros WHERE macro = 'cluster' FORMAT TabSeparated",
    )) === ""
  ) {
    stillMissing.push("macros.cluster");
  }
  if (
    (await queryAs(
      url,
      adminUser,
      adminPassword,
      "SELECT cluster FROM system.clusters WHERE cluster = 'polaris_local' FORMAT TabSeparated",
    )) === ""
  ) {
    stillMissing.push("clusters.polaris_local");
  }
  if (
    (await queryAs(
      url,
      adminUser,
      adminPassword,
      "SELECT name FROM system.user_directories WHERE type = 'local_directory' FORMAT TabSeparated",
    )) === ""
  ) {
    stillMissing.push("user_directories.local_directory");
  }
  if (stillMissing.length > 0) {
    throw new Error(
      `[clickhouse-bootstrap-local] config files were installed at ${configDDir} but the server did not pick them up after SYSTEM RELOAD CONFIG: ${stillMissing.join(", ")}. ` +
        `Restart your ClickHouse server (these settings can require a restart) and rerun 'make setup'.`,
    );
  }
  logger.info("[clickhouse-bootstrap-local] server config reload confirmed");
}

async function ensurePolarisUser({ url, user, password, adminUser, adminPassword, dryRun }) {
  logger.info(`[clickhouse-bootstrap-local] phase=user-bootstrap user=${user}`);
  const userProbe = await probe(url, user, password);
  if (userProbe.ok) {
    logger.info("[clickhouse-bootstrap-local] user already present");
    return;
  }
  if (dryRun) {
    logger.info(`[clickhouse-bootstrap-local] dry-run: would create user ${user} via ${adminUser}`);
    return;
  }
  const adminProbe = await probe(url, adminUser, adminPassword);
  if (!adminProbe.ok) {
    throw new Error(
      `[clickhouse-bootstrap-local] cannot auth as '${user}' nor as admin '${adminUser}' at ${url}. ` +
        `Bare-metal setup assumes ClickHouse is reachable at the default endpoint with the built-in '${adminUser}' superuser. ` +
        `polaris probe: ${userProbe.error}; admin probe: ${adminProbe.error}.`,
    );
  }
  const ident = safeIdent(user);
  await execAs(
    url,
    adminUser,
    adminPassword,
    `CREATE USER IF NOT EXISTS ${ident} IDENTIFIED WITH plaintext_password BY ${sqlString(password)} HOST ANY`,
  );
  await execAs(url, adminUser, adminPassword, `GRANT ALL ON *.* TO ${ident} WITH GRANT OPTION`);
  logger.info(`[clickhouse-bootstrap-local] created user ${user} via admin=${adminUser}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  const client = {
    url: envOr("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/+$/, ""),
    user: envOr("CLICKHOUSE_USER", "polaris"),
    password: envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };
  const adminUser = envOr("CLICKHOUSE_ADMIN_USER", "default");
  const adminPassword = envOr("CLICKHOUSE_ADMIN_PASSWORD", "");

  logger.info(
    `[clickhouse-bootstrap-local] url=${client.url} user=${client.user}${dryRun ? " (dry-run)" : ""}`,
  );

  try {
    await ensureLocalServerConfig({
      url: client.url,
      adminUser,
      adminPassword,
      dryRun,
    });
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }

  try {
    await ensurePolarisUser({
      url: client.url,
      user: client.user,
      password: client.password,
      adminUser,
      adminPassword,
      dryRun,
    });
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }

  logger.info("[clickhouse-bootstrap-local] phase=schema root=sql/clickhouse");
  try {
    const summary = await applyMigrations({ root: SQL_ROOT, client, dryRun, logger });
    logger.info(
      `[clickhouse-bootstrap-local] schema applied: ${summary.applied.length} file${summary.applied.length === 1 ? "" : "s"}, ${summary.totalStatements} statement${summary.totalStatements === 1 ? "" : "s"}`,
    );
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
    return;
  }

  logger.info("[clickhouse-bootstrap-local] phase=local-users root=infra/clickhouse/init");
  try {
    const summary = await applyMigrations({ root: LOCAL_INIT_ROOT, client, dryRun, logger });
    logger.info(
      `[clickhouse-bootstrap-local] local users applied: ${summary.applied.length} file${summary.applied.length === 1 ? "" : "s"}, ${summary.totalStatements} statement${summary.totalStatements === 1 ? "" : "s"}`,
    );
  } catch (err) {
    logger.error(err.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main();
}
