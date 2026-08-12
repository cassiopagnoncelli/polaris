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
//   node scripts/clickhouse-bootstrap-local.mjs --destroy       # drop the db
//
// `--destroy` drops the `polaris` database and returns; it applies nothing.
// It exists for `bin/setup`, which drops every Polaris store before
// rebuilding — and for ClickHouse that is the only way an edited table
// definition ever takes effect, since every file under sql/clickhouse/ is
// `CREATE ... IF NOT EXISTS` and therefore a no-op against an existing
// table. See the phase-2 note above.
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
//
// Probes use whichever user is already authenticated:
//   - docker compose: `polaris` (created via CLICKHOUSE_USER, has
//     CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 — can read system tables;
//     `default` is locked behind CLICKHOUSE_PASSWORD on this image).
//   - bare-metal: `default` (no-password superuser; polaris doesn't
//     exist yet — its CREATE is phase 1, after this function).
async function ensureLocalServerConfig({ url, user, password, adminUser, adminPassword, dryRun }) {
  logger.info("[clickhouse-bootstrap-local] phase=server-config-check");

  const probeUser = (await probe(url, user, password)).ok ? user : adminUser;
  const probePassword = probeUser === user ? password : adminPassword;
  logger.info(`[clickhouse-bootstrap-local] probing server config as ${probeUser}`);

  const macroRow = await queryAs(
    url,
    probeUser,
    probePassword,
    "SELECT substitution FROM system.macros WHERE macro = 'cluster' FORMAT TabSeparated",
  );
  const clusterRow = await queryAs(
    url,
    probeUser,
    probePassword,
    "SELECT cluster FROM system.clusters WHERE cluster = 'polaris_local' FORMAT TabSeparated",
  );
  const writeableStorageRow = await queryAs(
    url,
    probeUser,
    probePassword,
    "SELECT name FROM system.user_directories WHERE type = 'local_directory' FORMAT TabSeparated",
  );
  // Probe whether the distributed DDL queue is wired up. ClickHouse 25+
  // requires both an explicit <zookeeper> client config and an explicit
  // <distributed_ddl> stanza for ON CLUSTER DDL to work — even on a
  // single-replica cluster. Querying system.distributed_ddl_queue raises
  // NO_ELEMENTS_IN_CONFIG when either is missing, so a single probe
  // covers both Keeper and distributed_ddl in one shot.
  const ddlProbe = await fetch(
    `${url}/?query=${encodeURIComponent("SELECT 1 FROM system.distributed_ddl_queue LIMIT 0")}`,
    { headers: { Authorization: basicAuth(probeUser, probePassword) } },
  );
  const needsKeeper = !ddlProbe.ok;
  await ddlProbe.text();

  const needsMacros = macroRow === "";
  const needsCluster = clusterRow === "";
  const needsWriteableStorage = writeableStorageRow === "";

  if (!needsMacros && !needsCluster && !needsWriteableStorage && !needsKeeper) {
    logger.info(
      "[clickhouse-bootstrap-local] server config OK (macros, cluster, writeable user storage, keeper all present)",
    );
    return;
  }

  logger.info(
    `[clickhouse-bootstrap-local] missing: ${[
      needsMacros && "macros",
      needsCluster && "cluster",
      needsWriteableStorage && "writeable-user-storage",
      needsKeeper && "keeper",
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
  //
  // Re-declaring users_xml in this block is required: when a config.d file
  // defines <user_directories>, ClickHouse treats it as a full override of
  // the implicit users_xml storage (which is what holds the `default`
  // profile/user). Without it the server fails to start with
  // "Settings profile `default` not found".
  writeFileSync(
    resolve(configDDir, "polaris-access.xml"),
    `<!-- Generated by scripts/clickhouse-bootstrap-local.mjs. Polaris writeable user storage.
     Re-declares users_xml so the default profile/users from the base config
     remain reachable when we override <user_directories>. -->
<clickhouse>
  <user_directories>
    <users_xml>
      <path>${configXmlPath}</path>
    </users_xml>
    <local_directory>
      <path>${accessDir}/</path>
    </local_directory>
  </user_directories>
</clickhouse>
`,
  );

  // Embedded ClickHouse Keeper so single-replica ON CLUSTER DDL works
  // without an external coordination quorum. ClickHouse 25+ requires the
  // distributed DDL queue (which needs ZooKeeper/Keeper) even for
  // one-replica clusters; ClickHouse 24 implicitly bypassed it. The
  // production keeper.xml is more elaborate (different paths, container
  // hostnames); this local variant points everything at localhost and
  // uses the data dir for storage.
  const keeperLogDir = resolve(dataPath, "coordination", "log");
  const keeperSnapDir = resolve(dataPath, "coordination", "snapshots");
  writeFileSync(
    resolve(configDDir, "polaris-keeper.xml"),
    `<!-- Generated by scripts/clickhouse-bootstrap-local.mjs. Polaris embedded Keeper for local/dev. -->
<clickhouse>
  <keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>
    <log_storage_path>${keeperLogDir}</log_storage_path>
    <snapshot_storage_path>${keeperSnapDir}</snapshot_storage_path>
    <coordination_settings>
      <operation_timeout_ms>10000</operation_timeout_ms>
      <session_timeout_ms>30000</session_timeout_ms>
      <raft_logs_level>warning</raft_logs_level>
    </coordination_settings>
    <raft_configuration>
      <server>
        <id>1</id>
        <hostname>127.0.0.1</hostname>
        <port>9234</port>
      </server>
    </raft_configuration>
  </keeper_server>
  <zookeeper>
    <!-- 127.0.0.1, not localhost: Keeper binds IPv4 only by default and
         IPv6 lookup of 'localhost' would route to ::1 → connection refused. -->
    <node>
      <host>127.0.0.1</host>
      <port>9181</port>
    </node>
  </zookeeper>
  <!-- Required even when Keeper is configured: ClickHouse only enables
       the distributed DDL queue when <distributed_ddl> is explicitly set. -->
  <distributed_ddl>
    <path>/clickhouse/task_queue/ddl</path>
  </distributed_ddl>
</clickhouse>
`,
  );

  logger.info(`[clickhouse-bootstrap-local] installed config.d files into ${configDDir}`);

  // Reload config so the new files take effect.
  await execAs(url, adminUser, adminPassword, "SYSTEM RELOAD CONFIG");
  logger.info("[clickhouse-bootstrap-local] issued SYSTEM RELOAD CONFIG");

  // Re-probe so we fail loudly if reload didn't pick everything up.
  // user_directories and keeper changes both require a full server
  // restart (RELOAD CONFIG re-reads macros and remote_servers but not
  // user_directories or keeper_server / zookeeper).
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
  const postReloadDdl = await fetch(
    `${url}/?query=${encodeURIComponent("SELECT 1 FROM system.distributed_ddl_queue LIMIT 0")}`,
    { headers: { Authorization: basicAuth(adminUser, adminPassword) } },
  );
  await postReloadDdl.text();
  if (!postReloadDdl.ok) {
    stillMissing.push("distributed_ddl");
  }
  if (stillMissing.length > 0) {
    throw new Error(
      `[clickhouse-bootstrap-local] config files were installed at ${configDDir} but the server did not pick them up after SYSTEM RELOAD CONFIG: ${stillMissing.join(", ")}. ` +
        `Restart your ClickHouse server (user_directories and keeper require a restart) and rerun 'make setup'.`,
    );
  }
  logger.info("[clickhouse-bootstrap-local] server config reload confirmed");
}

async function ensurePolarisUser({ url, user, password, adminUser, adminPassword, dryRun }) {
  logger.info(`[clickhouse-bootstrap-local] phase=user-bootstrap user=${user}`);
  const userProbe = await probe(url, user, password);
  const userExists = userProbe.ok;

  if (dryRun) {
    logger.info(
      userExists
        ? "[clickhouse-bootstrap-local] dry-run: user already present, would reconcile grants"
        : `[clickhouse-bootstrap-local] dry-run: would create user ${user} via ${adminUser} and grant CURRENT GRANTS`,
    );
    return;
  }

  const adminProbe = await probe(url, adminUser, adminPassword);
  if (!adminProbe.ok) {
    if (userExists) {
      // User already authenticates AND we can't reach admin. Assume grants
      // were applied by a previous successful run; nothing to do.
      logger.info(
        "[clickhouse-bootstrap-local] user already present (admin unavailable, skipping grant reconcile)",
      );
      return;
    }
    throw new Error(
      `[clickhouse-bootstrap-local] cannot auth as '${user}' nor as admin '${adminUser}' at ${url}. ` +
        `Bare-metal setup assumes ClickHouse is reachable at the default endpoint with the built-in '${adminUser}' superuser. ` +
        `polaris probe: ${userProbe.error}; admin probe: ${adminProbe.error}.`,
    );
  }

  const ident = safeIdent(user);
  if (!userExists) {
    await execAs(
      url,
      adminUser,
      adminPassword,
      `CREATE USER IF NOT EXISTS ${ident} IDENTIFIED WITH plaintext_password BY ${sqlString(password)} HOST ANY`,
    );
    logger.info(`[clickhouse-bootstrap-local] created user ${user} via admin=${adminUser}`);
  }
  // Always (re)apply grants — idempotent — so a user created by an earlier
  // run that exited before granting ends up correctly privileged.
  //
  // `GRANT ALL` fails when the admin (default) doesn't hold every privilege
  // in ALL with grant option — e.g. NAMED COLLECTION ADMIN on recent
  // ClickHouse versions. `GRANT CURRENT GRANTS` grants polaris exactly what
  // the admin itself has, which is the right semantics here.
  await execAs(
    url,
    adminUser,
    adminPassword,
    `GRANT CURRENT GRANTS ON *.* TO ${ident} WITH GRANT OPTION`,
  );
  logger.info(
    `[clickhouse-bootstrap-local] reconciled grants on ${user} (CURRENT GRANTS from ${adminUser})`,
  );
}

/**
 * Drop the `polaris` database, and only that.
 *
 * `SYNC` matters: without it the drop is lazily asynchronous, and the
 * `CREATE DATABASE` that follows in the same `bin/setup` run can race the
 * detach and fail. With it, the statement returns once the database is
 * really gone.
 *
 * No `ON CLUSTER '{cluster}'`, unlike `sql/clickhouse/00_database.sql`.
 * Destroy is local-only — one node, one replica — so a plain drop is
 * already complete, and the clustered form would fail outright on a server
 * that has not been through phase 0 yet and has no `{cluster}` macro.
 *
 * Authenticating as `polaris` is the guard, not a convenience: on a machine
 * where that user does not exist there is nothing this script created, so
 * there is nothing for it to drop.
 */
async function destroyLocal(client) {
  const reachable = await probe(client.url, client.user, client.password);
  if (!reachable.ok) {
    logger.info(
      `[clickhouse-bootstrap-local] user ${client.user} cannot authenticate at ${client.url} ` +
        `(${reachable.error}) — nothing to drop`,
    );
    return;
  }
  await execAs(client.url, client.user, client.password, "DROP DATABASE IF EXISTS polaris SYNC");
  logger.info("[clickhouse-bootstrap-local] dropped database polaris");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const destroying = Boolean(args["destroy"]);

  const client = {
    url: envOr("CLICKHOUSE_URL", "http://localhost:8123").replace(/\/+$/, ""),
    user: envOr("CLICKHOUSE_USER", "polaris"),
    password: envOr("CLICKHOUSE_PASSWORD", "polaris"),
  };
  const adminUser = envOr("CLICKHOUSE_ADMIN_USER", "default");
  const adminPassword = envOr("CLICKHOUSE_ADMIN_PASSWORD", "");

  logger.info(
    `[clickhouse-bootstrap-local] url=${client.url} user=${client.user}${dryRun ? " (dry-run)" : ""}${destroying ? " (destroy)" : ""}`,
  );

  if (destroying) {
    try {
      await destroyLocal(client);
    } catch (err) {
      logger.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  try {
    await ensureLocalServerConfig({
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
