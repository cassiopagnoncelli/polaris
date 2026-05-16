/**
 * Behavioural tests for the Vault Agent sidecar token source
 * (DCJXEFE5).
 *
 * The source reads a token from a file the Agent owns and re-reads
 * on a configurable interval; it never makes HTTP calls. Tests pass
 * an in-memory `readToken` so they never touch the real filesystem.
 */
import { describe, expect, it } from "vitest";

import { VaultAgentTokenSource } from "../src/providers/vault-agent-token-source.js";
import { VaultAuthInternalError } from "../src/providers/vault-token-manager.js";

interface FakeClock {
  t: number;
  now(): number;
  advance(ms: number): void;
}

function fakeClock(initial = 1_000_000): FakeClock {
  return {
    t: initial,
    now() {
      return this.t;
    },
    advance(ms: number) {
      this.t += ms;
    },
  };
}

function recordingReader(initial: string): {
  reader: (path: string) => Promise<string>;
  reads: string[];
  setValue: (next: string) => void;
} {
  const reads: string[] = [];
  let value = initial;
  return {
    reads,
    setValue(next) {
      value = next;
    },
    async reader(path) {
      reads.push(path);
      return value;
    },
  };
}

describe("VaultAgentTokenSource", () => {
  it("reads the token from disk and caches the value", async () => {
    const clock = fakeClock();
    const { reader, reads } = recordingReader("hvs.agent-token-1");
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: reader,
      now: () => clock.now(),
    });

    expect(await source.token()).toBe("hvs.agent-token-1");
    expect(reads).toEqual(["/vault/secrets/token"]);
    // Second call inside the re-read window returns the cached value.
    clock.advance(1_000);
    expect(await source.token()).toBe("hvs.agent-token-1");
    expect(reads).toEqual(["/vault/secrets/token"]);
  });

  it("re-reads the file after rereadIntervalMs elapses", async () => {
    const clock = fakeClock();
    const { reader, reads, setValue } = recordingReader("hvs.v1");
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: reader,
      now: () => clock.now(),
      rereadIntervalMs: 1_000,
    });

    expect(await source.token()).toBe("hvs.v1");
    expect(reads).toHaveLength(1);

    // Inside the window — cached.
    clock.advance(500);
    setValue("hvs.v2");
    expect(await source.token()).toBe("hvs.v1");
    expect(reads).toHaveLength(1);

    // Past the window — re-reads and picks up the rotated value.
    clock.advance(700);
    expect(await source.token()).toBe("hvs.v2");
    expect(reads).toHaveLength(2);
  });

  it("trims whitespace from the file contents", async () => {
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: async () => "  hvs.with.surrounding-whitespace\n  ",
    });
    expect(await source.token()).toBe("hvs.with.surrounding-whitespace");
  });

  it("throws VaultAuthInternalError when the file is empty", async () => {
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: async () => "   \n  ",
    });
    await expect(source.token()).rejects.toBeInstanceOf(VaultAuthInternalError);
  });

  it("throws VaultAuthInternalError when the file is missing", async () => {
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(source.token()).rejects.toBeInstanceOf(VaultAuthInternalError);
  });

  it("`invalidate()` forces a re-read on the next call", async () => {
    const clock = fakeClock();
    const { reader, reads, setValue } = recordingReader("hvs.v1");
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: reader,
      now: () => clock.now(),
      rereadIntervalMs: 60_000,
    });

    expect(await source.token()).toBe("hvs.v1");
    expect(reads).toHaveLength(1);

    setValue("hvs.v2");
    source.invalidate();
    expect(await source.token()).toBe("hvs.v2");
    expect(reads).toHaveLength(2);
  });

  it("`lease()` returns undefined — the agent owns lease metadata", () => {
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      readToken: async () => "hvs.token",
    });
    expect(source.lease()).toBeUndefined();
  });

  it("shares a single in-flight read across concurrent callers", async () => {
    const clock = fakeClock();
    let resolveRead: (value: string) => void = () => {};
    let reads = 0;
    const source = new VaultAgentTokenSource({
      tokenPath: "/vault/secrets/token",
      now: () => clock.now(),
      readToken: () => {
        reads += 1;
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    });

    const a = source.token();
    const b = source.token();
    resolveRead("hvs.shared");

    expect(await a).toBe("hvs.shared");
    expect(await b).toBe("hvs.shared");
    expect(reads).toBe(1);
  });
});
