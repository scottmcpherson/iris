import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../../../app/types";
import type { HermesRuntimeConfig } from "../../../types/hermes";
import { ASSISTANT_THINKING_TEXT } from "../assistantStatus";
import { MessageAttachments, MessageContent, formatAudioPlaybackTime } from "../components/MessageContent";

const runtimeConfig: HermesRuntimeConfig = {
  connectionMode: "managed-local",
  activeConnectionId: "local",
  coreConnections: [
    {
      id: "local",
      name: "Local",
      mode: "managed-local",
      effectiveCoreApiUrl: "http://127.0.0.1:8765/v1",
    },
  ],
  provider: "openai",
  model: "gpt-5",
};

describe("formatAudioPlaybackTime", () => {
  it("formats short voice message durations", () => {
    expect(formatAudioPlaybackTime(0)).toBe("0:00");
    expect(formatAudioPlaybackTime(2.9)).toBe("0:02");
    expect(formatAudioPlaybackTime(62)).toBe("1:02");
  });

  it("formats longer audio without producing invalid time", () => {
    expect(formatAudioPlaybackTime(3661)).toBe("1:01:01");
    expect(formatAudioPlaybackTime(Number.NaN)).toBe("0:00");
  });
});

describe("MessageContent streaming status", () => {
  it("renders the thinking placeholder without trailing dots", () => {
    const message: Message = {
      id: "assistant-1",
      role: "assistant",
      content: ASSISTANT_THINKING_TEXT,
      streaming: true,
    };

    const html = renderToStaticMarkup(createElement(MessageContent, { message }));

    expect(html).toContain("thinking-shimmer");
    expect(html).toContain(`aria-label="${ASSISTANT_THINKING_TEXT}"`);
    expect(html).toContain(`>${ASSISTANT_THINKING_TEXT}<`);
    expect(html).not.toContain("Thinking...");
    expect(html).not.toContain("typing-caret");
  });

  it("uses the thinking shimmer instead of a typing caret while assistant text streams", () => {
    const message: Message = {
      id: "assistant-1",
      role: "assistant",
      content: "Starting",
      streaming: true,
    };

    const html = renderToStaticMarkup(createElement(MessageContent, { message }));

    expect(html).toContain("Starting");
    expect(html).toContain("mt-1.5");
    expect(html).toContain(`aria-label="${ASSISTANT_THINKING_TEXT}"`);
    expect(html).toContain(`>${ASSISTANT_THINKING_TEXT}<`);
    expect(html).not.toContain("typing-caret");
  });
});

describe("MessageAttachments", () => {
  it("does not render a remote image URL before it has been resolved for the desktop webview", () => {
    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        runtimeConfig,
        attachments: [
          {
            id: "att_123",
            kind: "image",
            mimeType: "image/png",
            name: "photo.png",
            size: 42,
            previewUrl: "http://127.0.0.1:8765/v1/attachments/att_123/preview",
            downloadUrl: "http://127.0.0.1:8765/v1/attachments/att_123/content",
          },
        ],
      }),
    );

    expect(html).toContain("message-attachment-file");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/v1/attachments/att_123/preview");
  });

  it("renders already browser-safe image previews directly", () => {
    const html = renderToStaticMarkup(
      createElement(MessageAttachments, {
        runtimeConfig,
        attachments: [
          {
            id: "draft_123",
            kind: "image",
            mimeType: "image/png",
            name: "photo.png",
            size: 42,
            previewUrl: "data:image/png;base64,abc123",
          },
        ],
      }),
    );

    expect(html).toContain('<img src="data:image/png;base64,abc123"');
    expect(html).toContain('alt="photo.png"');
  });
});
