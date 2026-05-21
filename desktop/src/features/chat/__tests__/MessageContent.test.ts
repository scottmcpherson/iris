import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "../../../app/types";
import { ASSISTANT_THINKING_TEXT } from "../assistantStatus";
import { MessageContent, formatAudioPlaybackTime } from "../components/MessageContent";

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
    expect(html).toContain("streaming-thinking-indicator");
    expect(html).toContain(`>${ASSISTANT_THINKING_TEXT}<`);
    expect(html).not.toContain("typing-caret");
  });
});
