import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  irisCoreAttachmentUrl,
  cloneIrisCoreAgent,
  createIrisCoreAgent,
  createIrisCoreAgentSkill,
  deleteIrisCoreAgent,
  getIrisCoreAgentMemory,
  getIrisCoreAutomationEvents,
  getIrisCoreAgentSkill,
  getIrisCoreAgentSkills,
  controlIrisCoreGateway,
  getIrisCoreEvents,
  getIrisCoreGatewayStatus,
  installIrisCoreHermesPlugin,
  getIrisCoreLatestEventCursor,
  getIrisCoreAttachmentDataUrl,
  getIrisCoreStatus,
  renameIrisCoreAgent,
  resetIrisCoreAgentMemory,
  saveIrisCoreAgentMemory,
  saveIrisCoreAgentSkill,
  sendIrisCoreMessage,
  updateIrisCoreSession,
  updateIrisCoreSessionReadState,
  updateIrisProject,
  uploadIrisCoreAttachment,
} from "../irisCore";
import { defaultRuntimeConfig } from "../../app/runtimeConfig";

const invoke = vi.hoisted(() => vi.fn());
const tauriRuntime = vi.hoisted(() => ({ value: false }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isTauri: () => tauriRuntime.value,
}));

describe("irisCore", () => {
  beforeEach(() => {
    invoke.mockReset();
    tauriRuntime.value = false;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns browser 401 responses without native fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, error: "Bearer token is required." }),
      })),
    );

    const result = await getIrisCoreEvents(7, 50, defaultRuntimeConfig, "agent_default");

    expect(result).toEqual({ ok: false, error: "Bearer token is required." });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses native transport immediately in Tauri", async () => {
    tauriRuntime.value = true;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    invoke.mockResolvedValue({ ok: true, events: [], cursor: 7 });

    const result = await getIrisCoreEvents(7, 50, defaultRuntimeConfig, "agent_default");

    expect(result).toEqual({ ok: true, events: [], cursor: 7 });
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_request",
      payload: expect.objectContaining({
        method: "GET",
        path: "/events?after=7&limit=50&agentId=agent_default",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      }),
    });
  });

  it("probes the latest Core event cursor without replaying persisted events", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, events: [], cursor: 80 }),
        };
      }),
    );

    const result = await getIrisCoreLatestEventCursor(defaultRuntimeConfig, "agent_default");

    expect(result.cursor).toBe(80);
    const query = new URL(calls[0]).searchParams;
    expect(query.get("after")).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(query.get("limit")).toBe("1");
    expect(query.get("agentId")).toBe("agent_default");
  });

  it("loads recent automation events without replaying unrelated history", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, events: [], cursor: 95 }),
        };
      }),
    );

    const result = await getIrisCoreAutomationEvents(50, defaultRuntimeConfig, "agent_default");

    expect(result.cursor).toBe(95);
    const query = new URL(calls[0]).searchParams;
    expect(query.get("after")).toBe("0");
    expect(query.get("limit")).toBe("50");
    expect(query.get("automationOnly")).toBe("true");
    expect(query.get("order")).toBe("desc");
    expect(query.get("agentId")).toBe("agent_default");
  });

  it("sends message POSTs with an idempotency key", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        sessionId: "session-1",
        canonicalSessionId: "session-1",
        messageId: "client-message-1",
        accepted: true,
        eventCursor: 3,
        session: {
          id: "session-1",
          agentId: "agent_default",
          title: "Hello",
          summary: "",
          createdAt: 1,
          updatedAt: 2,
          metadata: {},
          runtimeId: "runtime_local_hermes",
          runtimeProfile: "default",
          externalSessionId: "hermes-session-1",
          externalChatId: "core-chat-1",
          externalThreadId: "",
          origin: {},
        },
        runtime: {
          ok: true,
          accepted: true,
          chatId: "core-chat-1",
          messageId: "client-message-1",
          sessionId: "hermes-session-1",
        },
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await sendIrisCoreMessage(
      "session-1",
      { text: "hello", clientMessageId: "client-message-1" },
      defaultRuntimeConfig,
    );

    expect(result.canonicalSessionId).toBe("session-1");
    expect(result.session?.externalChatId).toBe("core-chat-1");
    expect(result.session?.externalSessionId).toBe("hermes-session-1");
    expect(result.runtime?.sessionId).toBe("hermes-session-1");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/sessions/session-1/messages"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Idempotency-Key": "client-message-1",
        }),
      }),
    );
  });

  it("calls agent-scoped gateway routes through Core transport", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        agentId: "agent_default",
        runtimeId: "runtime_local_hermes",
        profile: "default",
        action: init.method === "GET" ? "status" : "restart",
        command: { ok: true, status: 0 },
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await getIrisCoreGatewayStatus("agent_default", defaultRuntimeConfig);
    await controlIrisCoreGateway("agent_default", "restart", defaultRuntimeConfig);

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/v1/agents/agent_default/gateway/status"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/v1/agents/agent_default/gateway/restart"),
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("uses the selected profile gateway probe when building Core status", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/health")) {
        return jsonResponse({ ok: true, version: "0.1.0" });
      }
      if (url.endsWith("/v1/status")) {
        return jsonResponse({ ok: true });
      }
      if (url.endsWith("/v1/agents")) {
        return jsonResponse({
          ok: true,
          agents: [
            coreAgentFixture("default", true),
            coreAgentFixture("health", false),
          ],
        });
      }
      if (url.endsWith("/v1/runtimes")) {
        return jsonResponse({
          ok: true,
          runtimes: [{
            id: "runtime_local_hermes",
            status: {
              probe: {
                gateway: { ok: true, url: "http://127.0.0.1:8642" },
                management: { ok: true, url: "http://127.0.0.1:8765/health" },
                irisAdapter: { ok: true, profile: "default", url: "http://127.0.0.1:8766/health" },
              },
            },
          }],
        });
      }
      if (url.endsWith("/v1/agents/agent_health/gateway/status")) {
        return jsonResponse({
          ok: true,
          agentId: "agent_health",
          runtimeId: "runtime_local_hermes",
          profile: "health",
          action: "status",
          command: { ok: true, status: 0 },
          probe: {
            gateway: { ok: true, url: "http://127.0.0.1:8642" },
            management: { ok: true, url: "http://127.0.0.1:8765/health" },
            irisAdapter: {
              ok: false,
              profile: "default",
              requestedProfile: "health",
              error: "Iris adapter is for 'default', not 'health'.",
            },
          },
        });
      }
      return jsonResponse({ ok: false, error: `Unexpected ${url}` }, 404);
    });
    vi.stubGlobal("fetch", fetch);

    const result = await getIrisCoreStatus(defaultRuntimeConfig, "health");

    expect(result.activeProfile.name).toBe("default");
    expect(result.activeApiStatus?.ok).toBe(false);
    expect(result.activeApiStatus?.requestedProfile).toBe("health");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/agents/agent_health/gateway/status"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("calls the system plugin install endpoint through Core transport", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        hermesHome: "/home/user/.hermes",
        pluginPath: "/home/user/.hermes/plugins/iris-platform",
        enabled: true,
        restartRequired: true,
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await installIrisCoreHermesPlugin(defaultRuntimeConfig);

    expect(result.ok).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/system/install-hermes-plugin"),
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("loads protected attachment media through the native bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        blob: async () => new Blob(),
      })),
    );
    invoke.mockResolvedValue({ ok: true, dataUrl: "data:audio/mp4;base64,YQ==", mimeType: "audio/mp4" });

    const result = await getIrisCoreAttachmentDataUrl(
      defaultRuntimeConfig,
      "http://127.0.0.1:8765/v1/attachments/att_1/content",
      "audio/mp4",
    );

    expect(result).toEqual({ ok: true, dataUrl: "data:audio/mp4;base64,YQ==", mimeType: "audio/mp4" });
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_attachment_data",
      payload: {
        path: "http://127.0.0.1:8765/v1/attachments/att_1/content",
        mimeType: "audio/mp4",
        filename: "",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      },
    });
  });

  it("routes webm audio through the bridge so the desktop app can transcode it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    invoke.mockResolvedValue({ ok: true, dataUrl: "data:audio/mp4;base64,YQ==", mimeType: "audio/mp4" });

    const result = await getIrisCoreAttachmentDataUrl(
      defaultRuntimeConfig,
      "http://127.0.0.1:8765/v1/attachments/att_1/content",
      "audio/webm",
    );

    expect(result.mimeType).toBe("audio/mp4");
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_attachment_data",
      payload: {
        path: "http://127.0.0.1:8765/v1/attachments/att_1/content",
        mimeType: "audio/webm",
        filename: "",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      },
    });
  });

  it("routes webm filenames through the bridge even when the stored mime type is generic", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    invoke.mockResolvedValue({ ok: true, dataUrl: "data:audio/mp4;base64,YQ==", mimeType: "audio/mp4" });

    const result = await getIrisCoreAttachmentDataUrl(
      defaultRuntimeConfig,
      "http://127.0.0.1:8765/v1/attachments/att_1/content",
      "application/octet-stream",
      "dictation.webm",
    );

    expect(result.mimeType).toBe("audio/mp4");
    expect(fetch).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_attachment_data",
      payload: {
        path: "http://127.0.0.1:8765/v1/attachments/att_1/content",
        mimeType: "application/octet-stream",
        filename: "dictation.webm",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      },
    });
  });

  it("routes directly fetched webm blobs through the bridge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "audio/webm" }),
        blob: async () => new Blob(["audio"], { type: "audio/webm" }),
      })),
    );
    invoke.mockResolvedValue({ ok: true, dataUrl: "data:audio/mp4;base64,YQ==", mimeType: "audio/mp4" });

    const result = await getIrisCoreAttachmentDataUrl(
      defaultRuntimeConfig,
      "http://127.0.0.1:8765/v1/attachments/att_1/content",
      "application/octet-stream",
    );

    expect(result.mimeType).toBe("audio/mp4");
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_attachment_data",
      payload: {
        path: "http://127.0.0.1:8765/v1/attachments/att_1/content",
        mimeType: "audio/webm",
        filename: "",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      },
    });
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

    const pending = sendIrisCoreMessage(
      "session-1",
      { text: "hello", clientMessageId: "client-message-1" },
      defaultRuntimeConfig,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await pending;

    expect(result).toEqual({ ok: false, error: "timed out" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends full project edits through the project PATCH endpoint", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        project: {
          id: "project_1",
          name: "Iris",
          slug: "iris",
          defaultAgentId: "agent_default",
          systemPrompt: "Use repo-local context.",
          createdAt: 1,
          updatedAt: 2,
          archivedAt: null,
          metadata: {},
        },
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await updateIrisProject(
      "project_1",
      {
        name: "Iris",
        defaultAgentId: "agent_default",
        systemPrompt: "Use repo-local context.",
      },
      defaultRuntimeConfig,
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v1/projects/project_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "Iris",
          defaultAgentId: "agent_default",
          systemPrompt: "Use repo-local context.",
        }),
      }),
    );
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

    const result = await uploadIrisCoreAttachment(
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

    const result = await uploadIrisCoreAttachment(
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

  it("routes local-path attachment uploads through the explicit native action", async () => {
    invoke.mockResolvedValue({
      ok: true,
      attachment: {
        id: "att_local",
        name: "notes.txt",
        kind: "code",
        mimeType: "text/plain",
        size: 12,
        previewUrl: "",
        downloadUrl: "/v1/attachments/att_local/content",
      },
    });

    const result = await uploadIrisCoreAttachment(
      {
        localPath: "/tmp/notes.txt",
        name: "notes.txt",
        mimeType: "text/plain",
        profile: "default",
        messageId: "client-message-1",
      },
      defaultRuntimeConfig,
    );

    expect(result.ok).toBe(true);
    expect(result.attachment.downloadUrl).toBe("http://127.0.0.1:8765/v1/attachments/att_local/content");
    expect(invoke).toHaveBeenCalledWith("core_bridge", {
      action: "core_upload_path",
      payload: expect.objectContaining({
        localPath: "/tmp/notes.txt",
        runtime: defaultRuntimeConfig,
        connectionId: "core_local",
      }),
    });
  });

  it("does not rewrite browser or Tauri local preview URLs as Core paths", () => {
    expect(irisCoreAttachmentUrl(defaultRuntimeConfig, "asset://localhost/%2FUsers%2Fscott%2FDesktop%2Fphoto.png")).toBe(
      "asset://localhost/%2FUsers%2Fscott%2FDesktop%2Fphoto.png",
    );
    expect(irisCoreAttachmentUrl(defaultRuntimeConfig, "blob:http://localhost/local-preview")).toBe(
      "blob:http://localhost/local-preview",
    );
    expect(irisCoreAttachmentUrl(defaultRuntimeConfig, "data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
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

    await getIrisCoreAgentMemory("agent_default", defaultRuntimeConfig);
    await saveIrisCoreAgentMemory("agent_default", "memory", { content: "notes" }, defaultRuntimeConfig);
    await resetIrisCoreAgentMemory("agent_default", "user", { confirm: "RESET MEMORY" }, defaultRuntimeConfig);
    await getIrisCoreAgentSkills("agent_default", defaultRuntimeConfig);
    await getIrisCoreAgentSkill("agent_default", "skill_1", defaultRuntimeConfig);
    await createIrisCoreAgentSkill("agent_default", { name: "Skill", category: "personal", content: "# Skill" }, defaultRuntimeConfig);
    await saveIrisCoreAgentSkill("agent_default", "skill_1", { name: "Skill", category: "personal", content: "# Skill" }, defaultRuntimeConfig);
    await createIrisCoreAgent({ name: "research" }, defaultRuntimeConfig);
    await cloneIrisCoreAgent("agent_default", { name: "copy" }, defaultRuntimeConfig);
    await renameIrisCoreAgent("agent_default", { name: "renamed" }, defaultRuntimeConfig);
    await deleteIrisCoreAgent("agent_default", defaultRuntimeConfig);
    await updateIrisCoreSession("session_123", { title: "Pinned plan" }, defaultRuntimeConfig);
    await updateIrisCoreSessionReadState("session_123", "read", defaultRuntimeConfig);

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
      ["PATCH", "/v1/sessions/session_123"],
      ["PATCH", "/v1/sessions/session_123/read-state"],
    ]);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function coreAgentFixture(profile: string, isDefault = false) {
  return {
    id: `agent_${profile}`,
    runtimeId: "runtime_local_hermes",
    runtimeKind: "hermes",
    displayName: profile,
    runtimeProfile: profile,
    isDefault,
    metadata: {
      provider: "openai-codex",
      model: "gpt-5.5",
      path: `/tmp/${profile}`,
      exists: true,
      memoryBytes: 0,
      memoryUpdatedAt: null,
      skillCount: 0,
      sessionCount: 0,
      gatewayRunning: true,
    },
  };
}
