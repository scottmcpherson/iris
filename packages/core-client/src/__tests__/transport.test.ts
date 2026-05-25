import { describe, expect, it, vi } from "vitest";
import {
  cancelMessage,
  completeAgentSlashCommand,
  createIrisCoreClient,
  coreBaseUrl,
  coreRequest,
  getAgentModelCatalog,
  getAgentSlashCommands,
  updateSessionReadState,
  uploadAttachment,
} from "../index";

describe("core transport", () => {
  it("normalizes a base URL to /v1", () => {
    const client = createIrisCoreClient({ baseUrl: "http://127.0.0.1:8765/", fetch });
    expect(coreBaseUrl(client)).toBe("http://127.0.0.1:8765/v1");
  });

  it("does not duplicate /v1", () => {
    const client = createIrisCoreClient({ baseUrl: "http://127.0.0.1:8765/v1", fetch });
    expect(coreBaseUrl(client)).toBe("http://127.0.0.1:8765/v1");
  });

  it("sends JSON and idempotency headers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, accepted: true }),
    })) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    await coreRequest(client, "POST", "sessions/session_1/messages", { text: "Hi" }, { idempotencyKey: "cm_1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://core.local/v1/sessions/session_1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": "cm_1",
        }),
        body: JSON.stringify({ text: "Hi" }),
      }),
    );
  });

  it("calls agent model and slash-command endpoints", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, providers: [], commands: [], items: [] }),
    })) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    await getAgentModelCatalog(client, "agent_default");
    await getAgentSlashCommands(client, "agent_default");
    await completeAgentSlashCommand(client, "agent_default", "/me", 5);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://core.local/v1/agents/agent_default/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://core.local/v1/agents/agent_default/slash-commands",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://core.local/v1/agents/agent_default/slash-complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ text: "/me", limit: 5 }),
      }),
    );
  });

  it("posts cancel requests for active session messages", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, sessionId: "session_1" }),
    })) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    await cancelMessage(client, "session_1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://core.local/v1/sessions/session_1/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
  });

  it("patches session read state", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        readState: {
          sessionId: "session_1",
          state: "read",
          createdAt: 1,
          updatedAt: 2,
          metadata: { reason: "mobile-sidebar-selection" },
        },
      }),
    })) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    await updateSessionReadState(client, "session_1", "read", { reason: "mobile-sidebar-selection" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://core.local/v1/sessions/session_1/read-state",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ state: "read", metadata: { reason: "mobile-sidebar-selection" } }),
      }),
    );
  });

  it("uploads attachments as multipart form data and normalizes Core URLs", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input, init) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attachment: {
            id: "att_1",
            name: "notes.txt",
            kind: "code",
            mimeType: "text/plain",
            size: 2,
            previewUrl: "/v1/attachments/att_1/preview",
            downloadUrl: "/v1/attachments/att_1/content",
          },
        }),
      };
    }) as unknown as typeof fetch;
    const client = createIrisCoreClient({
      baseUrl: "http://core.local",
      fetch: fetchMock,
      headers: () => ({ Authorization: "Bearer token", "Content-Type": "application/json" }),
    });

    const result = await uploadAttachment(client, {
      file: new Blob(["hi"], { type: "text/plain" }),
      name: "notes.txt",
      mimeType: "text/plain",
      kind: "code",
      profile: "default",
      sessionId: "session_1",
      messageId: "message_1",
    });

    expect(result.attachment.previewUrl).toBe("http://core.local/v1/attachments/att_1/preview");
    expect(result.attachment.downloadUrl).toBe("http://core.local/v1/attachments/att_1/content");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://core.local/v1/attachments",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData),
      }),
    );
    const headers = capturedInit?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.has("Content-Type")).toBe(false);
  });

  it("uploads React Native URI files without the browser filename overload", async () => {
    const NativeFormData = globalThis.FormData;
    class FakeFormData {
      parts: unknown[][] = [];

      append(...args: unknown[]) {
        this.parts.push(args);
      }
    }

    vi.stubGlobal("FormData", FakeFormData);
    let capturedForm: FakeFormData | undefined;
    const fetchMock = vi.fn(async (_input, init) => {
      capturedForm = init?.body as FakeFormData;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          attachment: {
            id: "att_voice",
            name: "voice.m4a",
            kind: "audio",
            mimeType: "audio/mp4",
            size: 10,
            downloadUrl: "/v1/attachments/att_voice/content",
          },
        }),
      };
    }) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    try {
      await uploadAttachment(client, {
        file: { uri: "file:///tmp/voice.m4a", name: "voice.m4a", type: "audio/mp4" },
        name: "voice.m4a",
        mimeType: "audio/mp4",
        kind: "audio",
        profile: "default",
      });
    } finally {
      vi.stubGlobal("FormData", NativeFormData);
    }

    expect(capturedForm?.parts[0]).toEqual([
      "file",
      { uri: "file:///tmp/voice.m4a", name: "voice.m4a", type: "audio/mp4" },
    ]);
  });

  it("normalizes non-ok HTTP responses", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const client = createIrisCoreClient({ baseUrl: "http://core.local", fetch: fetchMock });

    await expect(coreRequest(client, "GET", "/health")).resolves.toMatchObject({
      ok: false,
      error: "HTTP 500",
    });
  });
});
