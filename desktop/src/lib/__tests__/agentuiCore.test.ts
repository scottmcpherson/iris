import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentUICoreEvents, sendAgentUICoreMessage } from "../agentuiCore";
import { defaultRuntimeConfig } from "../../app/runtimeConfig";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("agentuiCore", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("falls back through the native bridge when Core requires bearer auth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: "Bearer token is required." }),
      })),
    );
    invoke.mockResolvedValue({ ok: true, events: [], cursor: 7 });

    const result = await getAgentUICoreEvents(7, 50, defaultRuntimeConfig, "agent_default");

    expect(result).toEqual({ ok: true, events: [], cursor: 7 });
    expect(invoke).toHaveBeenCalledWith("hermes_bridge", {
      action: "core_request",
      payload: {
        method: "GET",
        path: "/events?after=7&limit=50&agentId=agent_default",
        body: undefined,
        runtime: defaultRuntimeConfig,
      },
    });
  });

  it("sends message POSTs with an idempotency key", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        conversationId: "conv-1",
        messageId: "client-message-1",
        accepted: true,
        eventCursor: 3,
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await sendAgentUICoreMessage(
      "conv-1",
      { text: "hello", clientMessageId: "client-message-1" },
      defaultRuntimeConfig,
    );

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/conversations/conv-1/messages"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "client-message-1",
        }),
      }),
    );
  });

  it("does not replay timed-out message POSTs through the native bridge", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      ),
    );

    const pending = sendAgentUICoreMessage(
      "conv-1",
      { text: "hello", clientMessageId: "client-message-1" },
      defaultRuntimeConfig,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: "timed out" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
