import { describe, expect, it, vi } from "vitest";

import { composeHooks, emitHook } from "../src/hooks.js";

describe("composeHooks", () => {
  it("returns empty hooks when no handlers are passed", () => {
    expect(composeHooks().onEvent).toBeUndefined();
  });

  it("returns a single-handler hook when one is passed", () => {
    const handler = vi.fn();
    const hooks = composeHooks(handler);
    hooks.onEvent?.("producer.connected", {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fans out across multiple handlers", () => {
    const a = vi.fn();
    const b = vi.fn();
    const hooks = composeHooks(a, b);
    hooks.onEvent?.("producer.message_sent", { topic: "raw.events" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("isolates handler errors so a single bad handler does not break the chain", () => {
    const bad = vi.fn(() => {
      throw new Error("bad handler");
    });
    const good = vi.fn();
    const hooks = composeHooks(bad, good);
    expect(() => hooks.onEvent?.("producer.connected", {})).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe("emitHook", () => {
  it("is a no-op when hooks are undefined", () => {
    expect(() => emitHook(undefined, "producer.connected", {})).not.toThrow();
  });

  it("invokes the handler with event + payload", () => {
    const handler = vi.fn();
    emitHook({ onEvent: handler }, "consumer.message_received", { topic: "raw.events" });
    expect(handler).toHaveBeenCalledWith("consumer.message_received", { topic: "raw.events" });
  });

  it("swallows handler errors", () => {
    expect(() =>
      emitHook(
        {
          onEvent() {
            throw new Error("nope");
          },
        },
        "producer.send_failed",
        {},
      ),
    ).not.toThrow();
  });
});
