#!/usr/bin/env node

// Seed `project_config` from the environment variables a service used before
// its cutover.
//
// Values do not appear by themselves. A service that stops reading
// `POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS` and starts reading
// `project_config[ingest].dedupe_window_sec` silently reverts every project to
// the deployment default unless something carries the old values across. This
// is that something.
//
// THREE PROPERTIES THIS SCRIPT IS BUILT AROUND
//
//   1. **It runs inside the target environment, never from a workstation.**
//      Its inputs are the currently deployed values, which live in that
//      environment's process environment — not in the repo. Run locally it
//      would faithfully seed development values into production, which is why
//      `--env` must be stated explicitly and is checked against `POLARIS_ENV`.
//
//   2. **It writes through the audited mutation, not raw SQL.** Every row it
//      creates carries an audit record, bumps the scope version, and notifies
//      running replicas — the same transaction an operator's `polaris config
//      set` produces. A backfill that bypassed that would leave the fleet
//      serving stale configuration and no trace of who seeded what.
//
//   3. **It is idempotent and dry by default.** Re-running changes nothing
//      when the stored value already matches; writing at all requires
//      `--apply`.
//
// `updated_by` is `migration`, reusing the actor vocabulary `audit_records`
// already defines, so a backfilled row stays distinguishable from an operator
// edit forever.
//
// Usage:
//
//   node scripts/backfill-project-config.mjs --service ingester-api --env production
//   node scripts/backfill-project-config.mjs --service ingester-api --env production --apply

import {
  listProjectConfig,
  setProjectConfigValueWithAudit,
} from "@polaris/shared-control-plane-db";
import { closeDb, createDb } from "@polaris/shared-db";
import { v7 as uuidv7 } from "uuid";

/**
 * One service's migration: which retired variables map to which config keys.
 *
 * A `parse` returns `{ projectId, value }[]`, so a single variable can expand
 * to one row per project — which is exactly what the two comma-separated
 * override strings do.
 */
const SERVICES = {
  "ingester-api": {
    namespace: "ingest",
    variables: [
      {
        env: "POLARIS_INGEST_PROJECT_DEDUPE_WINDOWS",
        key: "dedupe_window_sec",
        parse: parseProjectPairs,
      },
      {
        env: "POLARIS_RATE_LIMIT_PROJECT_OVERRIDES",
        key: "rate_limit_rps",
        parse: parseProjectPairs,
      },
    ],
  },
};

/**
 * Parse a `project_id=number,project_id=number` string.
 *
 * Deliberately strict: a malformed pair is reported and skipped rather than
 * guessed at. These strings were hand-maintained, so a typo is more likely
 * than in generated input, and seeding a wrong number silently is worse than
 * seeding nothing.
 */
export function parseProjectPairs(raw) {
  const out = [];
  const problems = [];
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { entries: out, problems };

  for (const entry of trimmed.split(",")) {
    const pair = entry.trim();
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    if (equals <= 0 || equals === pair.length - 1) {
      problems.push(`expected "project_id=value", got "${pair}"`);
      continue;
    }
    const projectId = pair.slice(0, equals).trim();
    const rawValue = pair.slice(equals + 1).trim();
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`invalid value for project "${projectId}": "${rawValue}"`);
      continue;
    }
    out.push({ projectId, value });
  }
  return { entries: out, problems };
}

/** Build the full plan without touching the database. */
export function planBackfill(service, env) {
  const spec = SERVICES[service];
  if (spec === undefined) {
    throw new Error(
      `unknown service "${service}" — known: ${Object.keys(SERVICES).sort().join(", ")}`,
    );
  }
  const rows = [];
  const problems = [];
  for (const variable of spec.variables) {
    const raw = env[variable.env];
    if (raw === undefined || raw.trim().length === 0) continue;
    const parsed = variable.parse(raw);
    for (const problem of parsed.problems) problems.push(`${variable.env}: ${problem}`);
    for (const entry of parsed.entries) {
      rows.push({
        projectId: entry.projectId,
        namespace: spec.namespace,
        configKey: variable.key,
        value: entry.value,
        source: variable.env,
      });
    }
  }
  return { rows, problems };
}

function parseArgs(argv) {
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--service") out.service = argv[++i];
    else if (arg === "--env") out.environment = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.service === undefined || args.environment === undefined) {
    console.error(
      "usage: backfill-project-config.mjs --service <name> --env <environment> [--apply]\n" +
        `known services: ${Object.keys(SERVICES).sort().join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  // The safety interlock. `--env` is what the operator BELIEVES they are
  // seeding; POLARIS_ENV is what this deployment actually is. A mismatch means
  // the script is running somewhere other than intended — the failure mode
  // that would write development values into production.
  const deployed = process.env["POLARIS_ENV"];
  if (deployed === undefined) {
    console.error(
      "POLARIS_ENV is not set. This script must run inside the target environment, where the\n" +
        "values it reads actually live — not from a workstation.",
    );
    process.exitCode = 2;
    return;
  }
  if (deployed !== args.environment) {
    console.error(
      `refusing to run: --env is "${args.environment}" but POLARIS_ENV is "${deployed}".\n` +
        "One of them is wrong, and guessing which would seed the wrong environment.",
    );
    process.exitCode = 2;
    return;
  }

  let plan;
  try {
    plan = planBackfill(args.service, process.env);
  } catch (err) {
    // An operator running this during a cutover deserves the message, not a
    // stack trace — the only thing that throws here is an unknown service
    // name, and its message already says what the known ones are.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }
  const { rows, problems } = plan;

  for (const problem of problems) console.error(`  malformed: ${problem}`);
  if (rows.length === 0) {
    console.log(
      `nothing to backfill for ${args.service} in ${args.environment}: the retired variables are ` +
        "unset or empty.",
    );
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  const db = createDb({
    postgres: {
      host: process.env["POLARIS_POSTGRES_HOST"] ?? "localhost",
      port: Number(process.env["POLARIS_POSTGRES_PORT"] ?? "5432"),
      database: process.env["POLARIS_POSTGRES_DATABASE"] ?? "polaris",
      user: process.env["POLARIS_POSTGRES_USER"] ?? "polaris",
      password: process.env["POLARIS_POSTGRES_PASSWORD"] ?? "polaris",
      ssl: process.env["POLARIS_POSTGRES_SSL"] === "true",
      poolMax: 4,
    },
  });

  let written = 0;
  let unchanged = 0;
  try {
    for (const row of rows) {
      const existing = await listProjectConfig(db, {
        projectId: row.projectId,
        environment: args.environment,
      });
      const current = existing.find(
        (candidate) =>
          candidate.namespace === row.namespace && candidate.config_key === row.configKey,
      );

      if (current !== undefined && current.value === row.value) {
        unchanged += 1;
        console.log(
          `  = ${row.projectId}/${row.namespace}.${row.configKey} already ${String(row.value)}`,
        );
        continue;
      }

      const verb = current === undefined ? "+" : "~";
      console.log(
        `  ${verb} ${row.projectId}/${row.namespace}.${row.configKey} = ${String(row.value)}` +
          `  (from ${row.source})`,
      );

      if (!args.apply) continue;

      await setProjectConfigValueWithAudit(
        db,
        {
          auditId: `polaris_aud_${uuidv7()}`,
          actorSource: "migration",
          actorLabel: "migration",
          reason: `backfill from ${row.source} during the ${args.service} cutover`,
          occurredAt: new Date(),
        },
        {
          projectId: row.projectId,
          environment: args.environment,
          namespace: row.namespace,
          configKey: row.configKey,
          value: row.value,
          isSecretRef: false,
        },
      );
      written += 1;
    }
  } finally {
    await closeDb(db);
  }

  if (args.apply) {
    console.log(`\nbackfill applied: ${String(written)} written, ${String(unchanged)} unchanged.`);
  } else {
    console.log(
      `\ndry run: ${String(rows.length - unchanged)} row(s) would be written, ` +
        `${String(unchanged)} already correct. Re-run with --apply.`,
    );
  }
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("backfill-project-config.mjs")) {
  await main();
}
