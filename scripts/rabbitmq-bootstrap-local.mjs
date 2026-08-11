#!/usr/bin/env node
// Polaris RabbitMQ local bootstrap.
//
// Idempotently creates the login user, vhost, and permissions that
// POLARIS_RABBITMQ_URL names on a bare-metal/local broker, so
// `pnpm rabbitmq:provision` can connect with the workspace default
// (amqp://polaris:polaris@localhost:5672).
//
// Docker compose does this provisioning via RABBITMQ_DEFAULT_USER /
// RABBITMQ_DEFAULT_PASS / RABBITMQ_DEFAULT_VHOST; a Homebrew or distro
// install ships only `guest`, hence this script. Without it the first
// bare-metal `make setup` dies with
//
//   Handshake terminated by server: 403 (ACCESS-REFUSED)
//
// which reads like a password typo rather than a missing user.
//
// Production never applies this. Production provisions the broker user
// out-of-band with least-privilege permissions and secret-managed
// credentials; the `administrator` tag set below is a local-dev
// convenience so the management UI works with the same login.
//
// Auth strategy: shells out to `rabbitmqctl`, which talks to the local node
// over Erlang distribution using the shared cookie — i.e. it works for the
// OS user that runs the broker, and needs no broker credentials. That is
// exactly the bare-metal case. When the broker is the docker-compose one,
// the user already exists and the connectivity probe below short-circuits
// before rabbitmqctl is ever consulted.

import { spawnSync } from "node:child_process";

import { connect } from "amqplib";

const DEFAULT_URL = "amqp://polaris:polaris@localhost:5672";

function parseTarget(raw) {
  const url = new URL(raw);
  // A trailing "/" means the default vhost; anything else is a vhost name
  // that arrives percent-encoded (the canonical "/" vhost is written %2F).
  const path = url.pathname.replace(/^\//, "");
  return {
    user: decodeURIComponent(url.username) || "guest",
    password: decodeURIComponent(url.password) || "guest",
    vhost: path === "" ? "/" : decodeURIComponent(path),
    endpoint: `${url.hostname}:${url.port || "5672"}`,
  };
}

async function credentialsUsable(url) {
  // The one authoritative check: can a client log in with the credentials
  // the rest of the workspace is configured to use? Everything below only
  // runs when the answer is no.
  try {
    const conn = await connect(url, { timeout: 5000 });
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

function ctl(args) {
  const res = spawnSync("rabbitmqctl", ["-q", ...args], { encoding: "utf8" });
  if (res.error?.code === "ENOENT") {
    throw new Error(
      `[rabbitmq-bootstrap-local] rabbitmqctl not found on PATH. ` +
        `Bare-metal setup assumes a local RabbitMQ install (brew install rabbitmq). ` +
        `If your broker runs elsewhere, create the user yourself:\n` +
        `  rabbitmqctl add_user <user> <password>\n` +
        `  rabbitmqctl set_user_tags <user> administrator\n` +
        `  rabbitmqctl set_permissions -p <vhost> <user> ".*" ".*" ".*"`,
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `[rabbitmq-bootstrap-local] rabbitmqctl ${args[0]} failed (exit ${res.status}):\n` +
        `${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  return res.stdout;
}

function ctlJson(args) {
  return JSON.parse(ctl(["--formatter=json", ...args]));
}

async function main() {
  const url = process.env.POLARIS_RABBITMQ_URL || DEFAULT_URL;
  const target = parseTarget(url);

  if (await credentialsUsable(url)) {
    console.log(
      `[rabbitmq-bootstrap-local] user ${target.user} already usable on vhost ${target.vhost} ` +
        `at ${target.endpoint} — nothing to do`,
    );
    return;
  }

  console.log(
    `[rabbitmq-bootstrap-local] user=${target.user} vhost=${target.vhost} endpoint=${target.endpoint}`,
  );

  const vhosts = ctlJson(["list_vhosts"]).map((v) => v.name);
  if (!vhosts.includes(target.vhost)) {
    ctl(["add_vhost", target.vhost]);
    console.log(`[rabbitmq-bootstrap-local] created vhost ${target.vhost}`);
  }

  const users = ctlJson(["list_users"]).map((u) => u.user);
  if (users.includes(target.user)) {
    // The user exists but could not log in, so the stored password is not
    // the one the workspace is configured with. Reset it rather than
    // failing: on a local broker the URL is the source of truth.
    ctl(["change_password", target.user, target.password]);
    console.log(`[rabbitmq-bootstrap-local] reset password for existing user ${target.user}`);
  } else {
    ctl(["add_user", target.user, target.password]);
    console.log(`[rabbitmq-bootstrap-local] created user ${target.user}`);
  }

  // administrator so the same login works in the management UI, which is
  // how a developer inspects the streams this bootstrap enables.
  ctl(["set_user_tags", target.user, "administrator"]);
  ctl(["set_permissions", "-p", target.vhost, target.user, ".*", ".*", ".*"]);
  console.log(
    `[rabbitmq-bootstrap-local] granted configure/write/read on ${target.vhost} to ${target.user}`,
  );

  if (!(await credentialsUsable(url))) {
    throw new Error(
      `[rabbitmq-bootstrap-local] user ${target.user} still cannot authenticate at ${target.endpoint} ` +
        `after bootstrap. Check that rabbitmqctl targets the same node that is listening there ` +
        `(rabbitmqctl status).`,
    );
  }
  console.log(`[rabbitmq-bootstrap-local] verified ${target.user}@${target.endpoint} can connect`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
