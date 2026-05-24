import { describe, expect, it, vi } from "vitest";
import { createIrisCoreClient, coreBaseUrl, coreRequest } from "../index";

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
