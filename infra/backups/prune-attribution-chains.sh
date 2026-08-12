#!/usr/bin/env bash
#
# Polaris attribution chain retention.
#
# Deletes `attribution_touchpoint_chains` rows that the processor's own
# attribution window has already made unreadable. Idempotent and safe to
# run from cron.
#
# Reference: docs/operations/backup-and-retention.md, "Attribution chain retention".
#
# ## Why this wraps the CLI instead of running SQL
#
# The sibling scripts here are dependency-free `psql` / `pg_dump` calls.
# This one shells out to `polaris processors chains-prune` on purpose.
#
# The rule that makes a prune safe — a row idle beyond the processor's
# window can never be read again — holds only for versions that HAVE a
# window. attribution-engine v1 has none, so deleting a v1 chain changes
# its output. That refusal lives in the audited mutation, along with the
# refusal of an idle window shorter than the version's own. A bare
# `DELETE FROM attribution_touchpoint_chains WHERE last_observed_at < ...`
# in a cron entry would silently bypass both, and would leave no audit
# row behind. The CLI is the sanctioned path precisely because it cannot
# be talked into an unsafe delete.
#
# ## Environment variables
#
#   POLARIS_PRUNE_VERSION      default v2      processor version to prune
#   POLARIS_PRUNE_PROJECT      unset           restrict to one project
#   POLARIS_PRUNE_ENV          unset           restrict to one environment
#   POLARIS_PRUNE_IDLE_SECONDS unset           override the window (longer only)
#   POLARIS_PRUNE_DRY_RUN      unset           set to 1 to count without deleting
#   POLARIS_OPERATOR_TOKEN     unset           required when POLARIS_PRUNE_ENV
#                                              is unset or `production`
#   POLARIS_CLI                default `polaris` on PATH
#
# Database connection comes from the CLI's own resolution
# (`POLARIS_DATABASE_URL` / `DATABASE_URL`, or the POLARIS_POSTGRES_*
# variables). This script deliberately does not re-implement it.
#
# ## The token requirement
#
# Leaving POLARIS_PRUNE_ENV unset means "every environment", which
# includes production — so the CLI treats an unscoped prune as a
# production mutation and refuses it without an operator token. That is
# deliberate: an unattended job that can delete production rows should
# carry a credential naming who authorised it, and the audit row then
# records `operator_token` rather than a bare `cli`.
#
# Two ways to satisfy it, both fine:
#
#   - put POLARIS_OPERATOR_TOKEN in the env file (root-owned, 0600), or
#   - schedule one entry per environment with POLARIS_PRUNE_ENV set, in
#     which case only the production entry needs the token. That is what
#     `crontab.example` does.
#
# ## Scheduling
#
# Daily is ample — the window is 90 days, so a row's eligibility does not
# change quickly, and the deletion is a bounded index scan on
# (processor_version, project_id, environment, last_observed_at).
#
#   17 3 * * *  /opt/polaris/infra/backups/prune-attribution-chains.sh >> /var/log/polaris/prune-chains.log 2>&1
#
# There is no locking. Two overlapping runs would both issue the same
# bounded DELETE; the second finds nothing and writes no audit row, which
# is why the mutation skips the audit write on a zero-row prune.
#
# ## Exit codes
#
#   0  prune succeeded (including "nothing to prune")
#   1  the prune command failed — see stderr; the refusals exit non-zero
#   2  configuration error (CLI not found)

set -euo pipefail

VERSION="${POLARIS_PRUNE_VERSION:-v2}"
CLI="${POLARIS_CLI:-polaris}"

if ! command -v "${CLI}" >/dev/null 2>&1; then
  echo "prune-attribution-chains: '${CLI}' not found on PATH. Set POLARIS_CLI to the polaris binary." >&2
  exit 2
fi

args=(processors chains-prune --version "${VERSION}")

if [[ -n "${POLARIS_PRUNE_PROJECT:-}" ]]; then
  args+=(--project "${POLARIS_PRUNE_PROJECT}")
fi
if [[ -n "${POLARIS_PRUNE_ENV:-}" ]]; then
  args+=(--env "${POLARIS_PRUNE_ENV}")
fi
if [[ -n "${POLARIS_PRUNE_IDLE_SECONDS:-}" ]]; then
  args+=(--idle "${POLARIS_PRUNE_IDLE_SECONDS}")
fi
if [[ "${POLARIS_PRUNE_DRY_RUN:-}" == "1" ]]; then
  args+=(--dry-run)
fi

echo "prune-attribution-chains: $(date -u +%Y-%m-%dT%H:%M:%SZ) running ${CLI} ${args[*]}"

# No `|| true`: a refusal (unprunable version, too-short idle window) must
# fail the cron entry loudly rather than be mistaken for a quiet success.
"${CLI}" "${args[@]}"
