# `@polaris/polaris-cli`

The `polaris` CLI is the v1 operator interface for the Polaris control plane.

It is a **thin client**: every command translates into one or more HTTP calls
against the control-plane API service (`apps/control-plane-api/`, scaffolded
by P6-000). The CLI never reaches PostgreSQL, Redpanda, or ClickHouse
directly — that is the API service's job.

This package (P6-001) ships only the **shell**:

- argv parsing (`commander`)
- config loading (`POLARIS_API_URL` + `POLARIS_TOKEN`, optional
  `~/.polaris/config.toml`)
- profile resolution (`--profile`, `POLARIS_PROFILE`)
- logger wiring through `@polaris/shared-logger`
- output streams (`human` and `json`) with stable exit codes
- the `polaris version` command
- a typed `CommandDefinition` surface that future tasks (P6-002+) plug into

The business commands (`projects`, `sources`, `keys`, `destinations`,
`processors`, `replays`, `operators`, `audit`, `export`) all land in their
own task cards.

## Authentication

There is no interactive login. Authentication follows the AWS-CLI /
GitHub-CLI tradition: bash-invocable, env-var-driven.

```bash
export POLARIS_API_URL="https://polaris.example.internal"
export POLARIS_TOKEN="polaris_ot_..."
polaris version
```

`POLARIS_TOKEN` is sent as `Authorization: Bearer <token>` on every API
request (the HTTP client itself lands with the first business-command task).
Tokens are issued by `polaris operators create` and rotated with
`polaris operators rotate`, both of which land in P6-007.

## Profiles

Operators juggling more than one environment can keep profiles in
`~/.polaris/config.toml`. The file is purely a convenience: it points each
profile at an env var that holds the bearer token. **The file never stores
tokens in plaintext, and tokens never appear on disk.**

```toml
default_profile = "production"

[profiles.production]
url = "https://polaris.example.internal"
token_env = "POLARIS_PROD_TOKEN"

[profiles.staging]
url = "https://polaris-staging.example.internal"
token_env = "POLARIS_STAGING_TOKEN"
```

Profile selection order, highest priority first:

1. `--profile <name>`
2. `POLARIS_PROFILE`
3. `default_profile` from the config file
4. fallback to env-var-only mode (`POLARIS_API_URL` + `POLARIS_TOKEN`)

If a profile is selected, `POLARIS_API_URL` and `POLARIS_TOKEN` are ignored
in favor of the profile's `url` and the env var the profile points at.

## Global flags

| Flag                    | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `-v, --version`         | Print the CLI version and exit                    |
| `--profile <name>`      | Profile defined in `~/.polaris/config.toml`       |
| `--output <human\|json>`| Output format (default `human`)                   |
| `--debug`               | Enable debug-level logging on stderr              |
| `--quiet`               | Suppress non-error output                         |

## Env vars

| Variable             | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `POLARIS_API_URL`    | Base URL of the control-plane API                       |
| `POLARIS_TOKEN`      | Bearer token (used when no profile is selected)         |
| `POLARIS_PROFILE`    | Default profile name                                    |
| `POLARIS_LOG_LEVEL`  | `fatal\|error\|warn\|info\|debug\|trace` (default `warn`) |
| `POLARIS_GIT_SHA`    | Optional build SHA shown by `polaris version`           |
| `POLARIS_BUILD_TIME` | Optional ISO 8601 build timestamp                       |
| `POLARIS_OUTPUT`     | `json` to emit JSON error envelopes on early failure    |
| `POLARIS_DEBUG`      | `1` to attach stack traces to unknown errors            |

## Exit codes

| Code | Meaning              |
| ---- | -------------------- |
| `0`  | success              |
| `1`  | generic failure      |
| `2`  | usage error          |
| `3`  | config error         |
| `4`  | auth error           |
| `5`  | not implemented stub |

## Extension surface

Each future task that adds a command exports one or more `CommandDefinition`
objects and appends them to the registry. For example:

```ts
import type { CommandDefinition } from "@polaris/polaris-cli";

export const keysListCommand: CommandDefinition = {
  id: "keys.list",
  mutates: false,
  register: (parent, deps) => {
    parent
      .command("list")
      .description("List API keys.")
      .action(
        deps.runCommand({ id: "keys.list", mutates: false }, async (_args, ctx) => {
          // ctx.config.apiUrl + ctx.config.token are ready to use
        }),
      );
  },
};
```

The `mutates` flag is recorded for every command so P6-007 can flip on the
production-mutation gate without touching command bodies.

## Build and test

```bash
pnpm --filter @polaris/polaris-cli typecheck
pnpm --filter @polaris/polaris-cli lint
pnpm --filter @polaris/polaris-cli test
pnpm --filter @polaris/polaris-cli build
```

After building, the `polaris` binary is available at
`apps/polaris-cli/dist/bin/polaris.js`.
