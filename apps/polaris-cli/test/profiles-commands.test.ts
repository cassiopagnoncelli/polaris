/**
 * `polaris profiles` — runner tests with injected stores, plus the
 * surface tests every command group carries.
 *
 * The properties worth protecting here are about REFUSING to guess: an
 * ambiguous identifier must not silently resolve to one of two people,
 * and a profile id that lost a merge must say so rather than looking
 * like an empty record.
 */

import { describe, expect, it } from "vitest";

import {
  buildProfilesLinksRunner,
  buildProfilesShowRunner,
  type CommandContext,
  ExitCode,
  type OutputStreams,
  profilesCommand,
  profilesLinksCommand,
  profilesShowCommand,
  type ProfilesLinksStore,
  type ProfilesShowStore,
  run,
} from "../src/index.js";

const META = {
  version: "0.0.0-test",
  gitSha: "testsha",
  buildTime: "2026-08-14T00:00:00Z",
  releaseLabel: "test",
  nodeVersion: process.version,
};

const WINNER = "019ffe00-0000-7000-8000-00000000f001";
const LOSER = "019ffe00-0000-7000-8000-00000000f002";

function captureOutput(): { streams: OutputStreams; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    stdout,
    stderr,
  };
}

function makeContext(streams: OutputStreams, output: "human" | "json" = "human"): CommandContext {
  const noopLogger = {
    fatal: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
  };
  return {
    config: {
      profile: "default",
      apiUrl: null,
      token: null,
      tokenEnvName: "POLARIS_TOKEN",
      output,
      logLevel: "warn",
      configFilePath: undefined,
    },
    logger: { ...noopLogger, child: () => noopLogger },
    output: streams,
    meta: META,
    actor: { source: "cli", label: "cli" },
    env: {},
  } as unknown as CommandContext;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    profile_id: WINNER,
    project_id: "storefront",
    environment: "development",
    canonical_customer_id: "cus_1",
    traits: { tier: "gold" },
    traits_version: 3,
    merged_into: null,
    first_seen_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:01.000Z",
    ...overrides,
  };
}

function showStore(overrides: Partial<ProfilesShowStore> = {}): ProfilesShowStore {
  return {
    byId: async () => null,
    byIdentifierValue: async () => [],
    identifiers: async () => [],
    merges: async () => [],
    close: async () => {},
    ...overrides,
  };
}

describe("profiles show", () => {
  it("resolves a profile_id directly, without needing project scope", async () => {
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () => showStore({ byId: async () => profile() }),
    });

    await runner({ target: WINNER }, makeContext(capture.streams, "json"));

    const parsed = JSON.parse(capture.stdout.join(""));
    expect(parsed.profile.profile_id).toBe(WINNER);
  });

  it("resolves an identifier value within a project scope", async () => {
    const capture = captureOutput();
    const seen: unknown[] = [];
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          byIdentifierValue: async (scope) => {
            seen.push(scope);
            return [{ kind: "customer_id", profile: profile() }];
          },
        }),
    });

    await runner(
      { target: "cus_1", project: "storefront", environment: "development" },
      makeContext(capture.streams, "json"),
    );

    expect(seen[0]).toEqual({
      project_id: "storefront",
      environment: "development",
      value: "cus_1",
    });
    expect(JSON.parse(capture.stdout.join("")).profile.profile_id).toBe(WINNER);
  });

  it("REFUSES an ambiguous value rather than picking a person", async () => {
    // The same string bound as two kinds may be two different people.
    // Guessing here means showing someone the wrong customer's traits.
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          byIdentifierValue: async () => [
            { kind: "anonymous_id", profile: profile() },
            { kind: "customer_id", profile: profile({ profile_id: LOSER }) },
          ],
        }),
    });

    await expect(
      runner(
        { target: "ambiguous", project: "storefront", environment: "development" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(capture.stdout.join("")).toBe("");
  });

  it("accepts --kind to resolve the ambiguity", async () => {
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          byIdentifierValue: async () => [
            { kind: "anonymous_id", profile: profile() },
            { kind: "customer_id", profile: profile({ profile_id: LOSER }) },
          ],
        }),
    });

    await runner(
      {
        target: "ambiguous",
        project: "storefront",
        environment: "development",
        kind: "customer_id",
      },
      makeContext(capture.streams, "json"),
    );

    expect(JSON.parse(capture.stdout.join("")).profile.profile_id).toBe(LOSER);
  });

  it("falls back to identifier lookup for a UUID that is not a profile_id", async () => {
    // The web SDK mints anonymous ids as UUIDs, so UUID-shaped does not
    // mean profile id.
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          byId: async () => null,
          byIdentifierValue: async () => [{ kind: "anonymous_id", profile: profile() }],
        }),
    });

    await runner(
      { target: LOSER, project: "storefront", environment: "development" },
      makeContext(capture.streams, "json"),
    );

    expect(JSON.parse(capture.stdout.join("")).profile.profile_id).toBe(WINNER);
  });

  it("requires project scope when the argument is not a known profile_id", async () => {
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({ openStore: () => showStore() });

    await expect(runner({ target: "cus_1" }, makeContext(capture.streams))).rejects.toMatchObject({
      name: "UsageError",
    });
  });

  it("says plainly that a profile lost a merge", async () => {
    // The id an operator holds is often the LOSER's — it was stamped into
    // ClickHouse before the merge. An empty-looking record with no
    // explanation is the worst possible answer.
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          byId: async () => profile({ profile_id: LOSER, merged_into: WINNER }),
        }),
    });

    await runner({ target: LOSER }, makeContext(capture.streams));

    const out = capture.stdout.join("");
    expect(out).toContain("MERGED AWAY into");
    expect(out).toContain(WINNER);
  });

  it("reports a miss as a usage error, not as an empty render", async () => {
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({ openStore: () => showStore() });

    await expect(
      runner(
        { target: "nobody", project: "storefront", environment: "development" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
  });

  it("closes the store even when resolution fails", async () => {
    let closed = false;
    const capture = captureOutput();
    const runner = buildProfilesShowRunner({
      openStore: () =>
        showStore({
          close: async () => {
            closed = true;
          },
        }),
    });

    await expect(
      runner(
        { target: "nobody", project: "storefront", environment: "development" },
        makeContext(capture.streams),
      ),
    ).rejects.toMatchObject({ name: "UsageError" });
    expect(closed).toBe(true);
  });
});

describe("profiles links", () => {
  function linksStore(overrides: Partial<ProfilesLinksStore> = {}): ProfilesLinksStore {
    return {
      byId: async () => profile(),
      identifiers: async () => [
        { kind: "anonymous_id", value: "anon_1" },
        { kind: "customer_id", value: "cus_1" },
      ],
      links: async () => [],
      merges: async () => [],
      close: async () => {},
      ...overrides,
    };
  }

  it("queries the ledger with identifiers in <kind>:<value> form", async () => {
    // The graph stores the halves separately; the ledger stores them
    // joined. Getting this wrong returns an empty trail that looks like
    // "no evidence" rather than "wrong query".
    const capture = captureOutput();
    const seen: unknown[] = [];
    const runner = buildProfilesLinksRunner({
      openStore: () =>
        linksStore({
          links: async (scope) => {
            seen.push(scope);
            return [];
          },
        }),
    });

    await runner({ profileId: WINNER }, makeContext(capture.streams, "json"));

    expect(seen[0]).toEqual({
      project_id: "storefront",
      environment: "development",
      identifiers: ["anonymous_id:anon_1", "customer_id:cus_1"],
    });
  });

  it("passes a custom --limit through to the ledger query", async () => {
    const capture = captureOutput();
    const limits: number[] = [];
    const runner = buildProfilesLinksRunner({
      openStore: () =>
        linksStore({
          links: async (_scope, limit) => {
            limits.push(limit);
            return [];
          },
        }),
    });

    await runner({ profileId: WINNER, limit: 5 }, makeContext(capture.streams, "json"));
    expect(limits).toEqual([5]);
  });

  it("distinguishes 'no pair to evidence' from 'joined by a merge'", async () => {
    // Both render an empty ledger; only one of them means evidence is
    // missing. Conflating them sends an operator looking for a bug.
    const single = captureOutput();
    await buildProfilesLinksRunner({
      openStore: () =>
        linksStore({ identifiers: async () => [{ kind: "customer_id", value: "cus_1" }] }),
    })({ profileId: WINNER }, makeContext(single.streams));
    expect(single.stdout.join("")).toContain("fewer than two identifiers");

    const merged = captureOutput();
    await buildProfilesLinksRunner({ openStore: () => linksStore() })(
      { profileId: WINNER },
      makeContext(merged.streams),
    );
    expect(merged.stdout.join("")).toContain("joined by a merge");
  });

  it("refuses an unknown profile rather than rendering an empty trail", async () => {
    const capture = captureOutput();
    const runner = buildProfilesLinksRunner({
      openStore: () => linksStore({ byId: async () => null }),
    });

    await expect(runner({ profileId: WINNER }, makeContext(capture.streams))).rejects.toMatchObject(
      { name: "UsageError" },
    );
  });

  it("refuses a non-positive --limit", async () => {
    const capture = captureOutput();
    const runner = buildProfilesLinksRunner({ openStore: () => linksStore() });

    await expect(
      runner({ profileId: WINNER, limit: 0 }, makeContext(capture.streams)),
    ).rejects.toMatchObject({ name: "UsageError" });
  });
});

describe("command surface", () => {
  it("is read-only: every profiles command carries mutates: false", async () => {
    // The group has no write path at all — the identity stage is the
    // profile store's only sync-path writer. A `true` here would mean
    // someone added a second one.
    expect(profilesCommand.mutates).toBe(false);
    expect(profilesShowCommand.mutates).toBe(false);
    expect(profilesLinksCommand.mutates).toBe(false);
  });

  it("`polaris profiles --help` lists show and links", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["profiles", "--help"],
      env: {},
      output: capture.streams,
      meta: META,
    });

    expect(code).toBe(ExitCode.Ok);
    const help = capture.stdout.join("");
    expect(help).toContain("show");
    expect(help).toContain("links");
  });

  it("fails with a config error when no database URL is set", async () => {
    const capture = captureOutput();
    const code = await run({
      argv: ["profiles", "show", WINNER],
      env: {},
      output: capture.streams,
      meta: META,
    });

    expect(code).toBe(ExitCode.ConfigError);
    expect(capture.stderr.join("")).toContain("DATABASE_URL");
  });
});
