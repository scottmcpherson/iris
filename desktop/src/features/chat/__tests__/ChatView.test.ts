import { describe, expect, it } from "vitest";
import { chatTranscriptScrollKey, shouldRenderMessageBody, shouldShowChatEmptyState } from "../ChatView";

describe("shouldShowChatEmptyState", () => {
  it("keeps the empty prompt for a brand-new chat", () => {
    expect(shouldShowChatEmptyState(null, 0)).toBe(true);
  });

  it("does not show empty or loading chrome while a selected session waits for messages", () => {
    expect(shouldShowChatEmptyState("session_123", 0)).toBe(false);
  });

  it("does not show the empty prompt once messages are visible", () => {
    expect(shouldShowChatEmptyState(null, 1)).toBe(false);
  });
});

describe("chatTranscriptScrollKey", () => {
  it("remounts the scroll frame when selected chat history arrives", () => {
    expect(chatTranscriptScrollKey("session_123", 0)).toBe("session_123:pending");
    expect(chatTranscriptScrollKey("session_123", 4)).toBe("session_123:ready");
  });

  it("keeps subsequent message updates in the same scroll frame", () => {
    expect(chatTranscriptScrollKey("session_123", 1)).toBe(chatTranscriptScrollKey("session_123", 8));
  });
});

describe("shouldRenderMessageBody", () => {
  it("omits the empty text bubble for attachment-only user messages", () => {
    expect(
      shouldRenderMessageBody({
        id: "message-1",
        role: "user",
        content: "",
        attachments: [
          {
            id: "att_audio_1",
            kind: "audio",
            mimeType: "audio/webm",
            name: "dictation.webm",
            size: 36_000,
          },
        ],
      }),
    ).toBe(false);
  });

  it("keeps the message body when text or streaming chrome is visible", () => {
    expect(shouldRenderMessageBody({ id: "message-1", role: "user", content: "hello" })).toBe(true);
    expect(shouldRenderMessageBody({ id: "message-2", role: "assistant", content: "", streaming: true })).toBe(true);
  });
});

describe("composer responsive layout", () => {
  it("keeps the model selector available at narrow widths", async () => {
    // @ts-expect-error The desktop tsconfig intentionally omits Node types, but Vitest runs in Node.
    const { readFileSync } = await import("node:fs");
    const appCss = readFileSync(new URL("../../../App.css", import.meta.url), "utf8") as string;

    expect(appCss).not.toMatch(/\.composer-model-menu-wrap\s*{[^}]*display:\s*none/i);
    expect(appCss).toMatch(/\.composer-model-menu-wrap\s*{[^}]*display:\s*inline-flex/i);
  });
});
