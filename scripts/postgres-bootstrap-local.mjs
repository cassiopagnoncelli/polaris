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
// Auth strategy: shells out to `psql` against `postgres` on the default
// endpoint, trying these superuser candidates in order:
//   1. $PGUSER          (explicit override)
//   2. $USER            (Postgres.app on macOS makes the OS user superuser)
//   3. "postgres"       (most Linux distros)
//
// `-w` is passed so psql never prompts. If none can connect, the script
// fails with a connection-style error and a hint about the bare-metal
// assumption.

import { spawnSync } from "node:child_process";

const HOST = process.env.PGHOST ?? "localhost";
const PORT = String(process.env.PGPORT ?? "5432");
const TARGET_ROLE = "polaris";
const TARGET_PASSWORD = "polaris";
const TARGET_DB = "polaris";

function runPsql(user, sql) {
  // -X (no psqlrc) so the user's local psql config — \timing, \pset, etc. —
  // can't pollute the output we parse. -tA gives unaligned tuples-only.
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
      "postgres",
      "-w",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ],
    { encoding: "utf8" },
  );
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

function main() {
  if (polarisAlreadyUsable()) {
    console.log(
      `[postgres-bootstrap-local] role ${TARGET_ROLE} + database ${TARGET_DB} already usable at ${HOST}:${PORT} — nothing to do`,
    );
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
