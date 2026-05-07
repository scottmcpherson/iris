import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentUICoreAttachmentUrl,
  getAgentUICoreEvents,
  sendAgentUICoreMessage,
  uploadAgentUICoreAttachment,
} from "../agentuiCore";
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

  it("uploads file attachments as multipart form data and resolves Core URLs", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("profile")).toBe("default");
      expect(form.get("kind")).toBe("image");
      expect(form.get("messageId")).toBe("client-message-1");
      expect(form.get("file")).toBeInstanceOf(File);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attachment: {
            id: "att_123",
            name: "photo.png",
            kind: "image",
            mimeType: "image/png",
            size: 12,
            previewUrl: "/v1/attachments/att_123/preview",
            downloadUrl: "/v1/attachments/att_123/content",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetch);

    const result = await uploadAgentUICoreAttachment(
      {
        file: new File(["image-bytes"], "photo.png", { type: "image/png" }),
        name: "photo.png",
        mimeType: "image/png",
        kind: "image",
        profile: "default",
        messageId: "client-message-1",
      },
      defaultRuntimeConfig,
    );

    expect(result.ok).toBe(true);
    expect(result.attachment.previewUrl).toBe("http://127.0.0.1:8765/v1/attachments/att_123/preview");
    expect(result.attachment.downloadUrl).toBe("http://127.0.0.1:8765/v1/attachments/att_123/content");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/attachments",
      expect.objectContaining({
        method: "POST",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("does not rewrite browser or Tauri local preview URLs as Core paths", () => {
    expect(agentUICoreAttachmentUrl(defaultRuntimeConfig, "asset://localhost/%2FUsers%2Fscott%2FDesktop%2Fphoto.png")).toBe(
      "asset://localhost/%2FUsers%2Fscott%2FDesktop%2Fphoto.png",
    );
    expect(agentUICoreAttachmentUrl(defaultRuntimeConfig, "blob:http://localhost/local-preview")).toBe(
      "blob:http://localhost/local-preview",
    );
    expect(agentUICoreAttachmentUrl(defaultRuntimeConfig, "data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
  });
});
