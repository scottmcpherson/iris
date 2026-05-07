import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentUICoreAttachmentUrl,
  cloneAgentUICoreAgent,
  createAgentUICoreAgent,
  createAgentUICoreAgentSkill,
  deleteAgentUICoreAgent,
  getAgentUICoreAgentMemory,
  getAgentUICoreAgentSkill,
  getAgentUICoreAgentSkills,
  getAgentUICoreEvents,
  renameAgentUICoreAgent,
  resetAgentUICoreAgentMemory,
  saveAgentUICoreAgentMemory,
  saveAgentUICoreAgentSkill,
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
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
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

  it.each([
    ["report.pdf", "application/pdf", "document"],
    ["clip.mp4", "video/mp4", "video"],
    ["payload.bin", "application/octet-stream", "file"],
  ])("uploads %s with the richer attachment kind", async (filename, mimeType, kind) => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("kind")).toBe(kind);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attachment: {
            id: "att_123",
            name: filename,
            kind,
            mimeType,
            size: 12,
            previewUrl: "",
            downloadUrl: "/v1/attachments/att_123/content",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetch);

    const result = await uploadAgentUICoreAttachment(
      {
        file: new File(["file-bytes"], filename, { type: mimeType }),
        name: filename,
        mimeType,
        profile: "default",
        messageId: "client-message-1",
      },
      defaultRuntimeConfig,
    );

    expect(result.ok).toBe(true);
    expect(result.attachment.kind).toBe(kind);
    expect(result.attachment.downloadUrl).toBe("http://127.0.0.1:8765/v1/attachments/att_123/content");
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

  it("routes agent resources through agent-scoped Core endpoints", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }),
    );

    await getAgentUICoreAgentMemory("agent_default", defaultRuntimeConfig);
    await saveAgentUICoreAgentMemory("agent_default", "memory", { content: "notes" }, defaultRuntimeConfig);
    await resetAgentUICoreAgentMemory("agent_default", "user", { confirm: "RESET MEMORY" }, defaultRuntimeConfig);
    await getAgentUICoreAgentSkills("agent_default", defaultRuntimeConfig);
    await getAgentUICoreAgentSkill("agent_default", "skill_1", defaultRuntimeConfig);
    await createAgentUICoreAgentSkill("agent_default", { name: "Skill", category: "personal", content: "# Skill" }, defaultRuntimeConfig);
    await saveAgentUICoreAgentSkill("agent_default", "skill_1", { name: "Skill", category: "personal", content: "# Skill" }, defaultRuntimeConfig);
    await createAgentUICoreAgent({ name: "research" }, defaultRuntimeConfig);
    await cloneAgentUICoreAgent("agent_default", { name: "copy" }, defaultRuntimeConfig);
    await renameAgentUICoreAgent("agent_default", { name: "renamed" }, defaultRuntimeConfig);
    await deleteAgentUICoreAgent("agent_default", defaultRuntimeConfig);

    expect(calls.map((call) => [call.init.method, new URL(call.url).pathname])).toEqual([
      ["GET", "/v1/agents/agent_default/memory"],
      ["PUT", "/v1/agents/agent_default/memory/memory"],
      ["DELETE", "/v1/agents/agent_default/memory/user"],
      ["GET", "/v1/agents/agent_default/skills"],
      ["GET", "/v1/agents/agent_default/skills/skill_1"],
      ["POST", "/v1/agents/agent_default/skills"],
      ["PUT", "/v1/agents/agent_default/skills/skill_1"],
      ["POST", "/v1/agents"],
      ["POST", "/v1/agents/agent_default/clone"],
      ["PATCH", "/v1/agents/agent_default"],
      ["DELETE", "/v1/agents/agent_default"],
    ]);
  });
});
