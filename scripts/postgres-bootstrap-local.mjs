#!/usr/bin/env node
// Polaris PostgreSQL local bootstrap.
//
// Idempotently creates the `polaris` login role and the `polaris` database
// on a bare-metal/local PostgreSQL instance, so `pnpm db:migrate` can
// connect with the workspace-default DATABASE_URL
// (postgres://polaris:polaris@localhost:5432/polaris).
//
// Docker compose does this provisioning via the POSTGRES_USER / POSTGRES_DB
// env vars; bare-metal installs do not, hence this script.
//
// Production never applies this. Production provisions the polaris role and
// database out-of-band (RDS bootstrap, secret-managed credentials).
//
// Usage:
//   node scripts/postgres-bootstrap-local.mjs             # create role + db
//   node scripts/postgres-bootstrap-local.mjs --destroy   # drop the database
//
// `--destroy` drops the `polaris` database and leaves the role alone. It
// exists for `bin/setup`, which drops every Polaris store before rebuilding.
// The role is not data, and dropping it would strand the docker path, where
// compose creates it from POSTGRES_USER and nothing on the host can put it
// back.
//
// Auth strategy, in order — the first that works wins:
//   1. polaris -> `polaris`   already usable, nothing to do
//   2. polaris -> `postgres`  the role exists and can manage its own
//                             database: it owns it (bare-metal CREATEDB, or
//                             docker where POSTGRES_USER made it superuser),
//                             and an owner can both create and drop it. This
//                             is the only path that works on docker, where
//                             no host-side superuser can log in at all.
//   3. a host superuser       first run bare-metal, when the role itself
//                             does not exist yet. Candidates in order:
//                               a. $PGUSER  (explicit override)
//                               b. $USER    (Postgres.app makes the OS user
//                                            a superuser on macOS)
//                               c. "postgres" (most Linux distros)
//
// `-w` is passed so psql never prompts. If nothing can connect, the script
// fails with a connection-style error and a hint about the bare-metal
// assumption.

import { spawnSync } from "node:child_process";

const HOST = process.env.PGHOST ?? "localhost";
const PORT = String(process.env.PGPORT ?? "5432");
const TARGET_ROLE = "polaris";
const TARGET_PASSWORD = "polaris";
const TARGET_DB = "polaris";

function runPsql(user, sql) {
  return runPsqlOn(user, "postgres", sql);
}

/**
 * Run one statement as `user` against `database`.
 *
 * `PGPASSWORD` is set to the canonical dev password only for the target
 * role; a host superuser connects over local trust/peer auth and must not
 * inherit it.
 */
function runPsqlOn(user, database, sql) {
  // -X (no psqlrc) so the user's local psql config — \timing, \pset, etc. —
  // can't pollute the output we parse. -tA gives unaligned tuples-only.
  const env = { ...process.env };
  if (user === TARGET_ROLE) env.PGPASSWORD = TARGET_PASSWORD;
  return spawnSync(
    "psql",
    [
      "-X",
      "-h",
      HOST,
      "-p",
      PORT,
      "-U",
      user,
      "-d",
      database,
      "-w",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ],
    { encoding: "utf8", env },
  );
}

/**
 * Can the `polaris` role reach the `postgres` maintenance database?
 *
 * That is the question that decides whether a host superuser is needed at
 * all. When the answer is yes the role can create and drop its own
 * database, which covers every case except a bare-metal first run.
 */
function polarisCanManageDatabases() {
  const res = runPsqlOn(TARGET_ROLE, "postgres", "SELECT 1");
  return res.status === 0 && res.stdout.trim() === "1";
}

function execOn(user, database, sql) {
  const res = runPsqlOn(user, database, sql);
  if (res.status !== 0) {
    throw new Error(
      `[postgres-bootstrap-local] psql failed (exit ${res.status}):\n${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout.trim();
}

function superuserCandidates() {
  const seen = new Set();
  const out = [];
  for (const u of [process.env.PGUSER, process.env.USER, "postgres"]) {
    if (typeof u === "string" && u.length > 0 && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function pickSuperuser() {
  const candidates = superuserCandidates();
  const attempts = [];
  for (const user of candidates) {
    const res = runPsql(user, "SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
    if (res.status === 0 && res.stdout.trim() === "t") {
      return user;
    }
    const detail = res.stderr.trim() || `exit ${res.status}, stdout=${res.stdout.trim()}`;
    attempts.push(`${user}: ${detail}`);
  }
  throw new Error(
    `[postgres-bootstrap-local] could not connect as a superuser to ${HOST}:${PORT}. ` +
      `Tried users: ${candidates.join(", ")}. ` +
      `Bare-metal setup assumes PostgreSQL is reachable at the default endpoint with at least one local superuser. ` +
      `Attempts:\n  ${attempts.join("\n  ")}`,
  );
}

function exec(user, sql) {
  const res = runPsql(user, sql);
  if (res.status !== 0) {
    throw new Error(
      `[postgres-bootstrap-local] psql failed (exit ${res.status}):\n${res.stderr.trim() || res.stdout.trim()}`,
    );
  }
  return res.stdout.trim();
}

function polarisAlreadyUsable() {
  // Short-circuit when the target role/db are already in place AND the
  // canonical polaris/polaris credentials work. Docker compose pre-creates
  // both via POSTGRES_USER / POSTGRES_DB env vars, so there's nothing for
  // this script to do (and trying to probe a host-side superuser against
  // the docker postgres fails with "no password supplied" because the
  // container's pg_hba.conf requires md5 for all logins).
  //
  // PGPASSWORD=polaris is the canonical password defined in
  // docker-compose.yml; bare-metal users who picked a different password
  // can still run this script — the polaris-as-polaris probe will fail
  // and we fall through to the superuser-bootstrap path.
  const res = spawnSync(
    "psql",
    ["-X", "-h", HOST, "-p", PORT, "-U", TARGET_ROLE, "-d", TARGET_DB, "-w", "-tAc", "SELECT 1"],
    {
      encoding: "utf8",
      env: { ...process.env, PGPASSWORD: TARGET_PASSWORD },
    },
  );
  return res.status === 0 && res.stdout.trim() === "1";
}

/**
 * Drop the `polaris` database. The role survives — see the header.
 *
 * Runs as the `polaris` role, which owns the database in both layouts and
 * can therefore drop it without a host superuser. If that role cannot log
 * in there is nothing this script created, so there is nothing to drop.
 *
 * Open connections have to go first: PostgreSQL refuses to drop a database
 * that anyone is connected to. `bin/setup` stops the dev stack before
 * calling this, which covers the services; this covers the psql session or
 * GUI client someone left open in another window. A non-superuser may
 * always terminate backends belonging to its own role, which is all of
 * them here.
 */
function destroyLocal() {
  if (!polarisCanManageDatabases()) {
    console.log(
      `[postgres-bootstrap-local] role ${TARGET_ROLE} cannot log in at ${HOST}:${PORT} — nothing to drop`,
    );
    return;
  }

  execOn(
    TARGET_ROLE,
    "postgres",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity ` +
      `WHERE datname = '${TARGET_DB}' AND pid <> pg_backend_pid()`,
  );
  execOn(TARGET_ROLE, "postgres", `DROP DATABASE IF EXISTS "${TARGET_DB}"`);
  console.log(`[postgres-bootstrap-local] dropped database ${TARGET_DB}`);
}

function main() {
  if (process.argv.includes("--destroy")) {
    destroyLocal();
    return;
  }

  if (polarisAlreadyUsable()) {
    console.log(
      `[postgres-bootstrap-local] role ${TARGET_ROLE} + database ${TARGET_DB} already usable at ${HOST}:${PORT} — nothing to do`,
    );
    return;
  }

  // The role exists and can reach `postgres`, so it can recreate its own
  // database — the state a `--destroy` run leaves behind, and the only path
  // available on docker, where no host superuser can authenticate.
  if (polarisCanManageDatabases()) {
    const hasDb = execOn(
      TARGET_ROLE,
      "postgres",
      `SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'`,
    );
    if (hasDb === "") {
      execOn(TARGET_ROLE, "postgres", `CREATE DATABASE "${TARGET_DB}" OWNER "${TARGET_ROLE}"`);
      console.log(
        `[postgres-bootstrap-local] created database ${TARGET_DB} as ${TARGET_ROLE} (no superuser needed)`,
      );
    }
    return;
  }

  const admin = pickSuperuser();
  console.log(`[postgres-bootstrap-local] superuser=${admin} host=${HOST}:${PORT}`);

  const hasRole = exec(admin, `SELECT 1 FROM pg_roles WHERE rolname = '${TARGET_ROLE}'`);
  if (hasRole === "") {
    exec(admin, `CREATE ROLE "${TARGET_ROLE}" LOGIN PASSWORD '${TARGET_PASSWORD}' CREATEDB`);
    console.log(`[postgres-bootstrap-local] created role ${TARGET_ROLE}`);
  } else {
    console.log(`[postgres-bootstrap-local] role ${TARGET_ROLE} already present`);
  }

  const hasDb = exec(admin, `SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'`);
  if (hasDb === "") {
    exec(admin, `CREATE DATABASE "${TARGET_DB}" OWNER "${TARGET_ROLE}"`);
    console.log(`[postgres-bootstrap-local] created database ${TARGET_DB} owner=${TARGET_ROLE}`);
  } else {
    console.log(`[postgres-bootstrap-local] database ${TARGET_DB} already present`);
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
