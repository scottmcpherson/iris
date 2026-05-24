import { describe, expect, it } from "vitest";
import {
  chatTranscriptScrollKey,
  composerModelSelection,
  slashCommandArrowDirection,
  shouldLockComposerModelSelection,
  shouldRenderMessageBody,
  shouldShowChatEmptyState,
  shouldShowRuntimeNotice,
  shouldShowVisibleDictationStatus,
} from "../ChatView";

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
    const { readFileSync } = await import("node:fs");
    const chatSource = readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8") as string;

    // The model menu wrap must stay inline-flex (never display:none) so the
    // selector remains reachable at narrow composer widths.
    expect(chatSource).toContain('<div className="relative inline-flex">');
    expect(chatSource).not.toMatch(/className=["'][^"']*\bhidden\b[^"']*["'][^>]*ModelMenu/);
  });

  it("keeps the slash command menu taller than the textarea wrapper", async () => {
    const { readFileSync } = await import("node:fs");
    const menuSource = readFileSync(
      new URL("../components/SlashCommandMenu.tsx", import.meta.url),
      "utf8",
    ) as string;
    const commandSource = readFileSync(
      new URL("../../../shared/ui/command.tsx", import.meta.url),
      "utf8",
    ) as string;

    expect(menuSource).toContain("h-auto max-h-80");
    expect(menuSource).not.toContain("max-h-none overflow-visible");
    expect(menuSource).toContain("max-h-[306px] scroll-py-[7px] overflow-x-hidden overflow-y-auto");
    expect(menuSource).toContain("value={activeCommand?.id || \"\"}");
    expect(menuSource).toContain("onValueChange={(value) =>");
    expect(menuSource).toContain("const listRef = useRef<HTMLDivElement | null>(null)");
    expect(menuSource).toContain("list.scrollTop +=");
    expect(commandSource).toContain("const CommandList = React.forwardRef");
    expect(commandSource).toContain("const CommandItem = React.forwardRef");
  });

  it("clears slash menu dismissal after the slash token changes", async () => {
    const { readFileSync } = await import("node:fs");
    const chatSource = readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8") as string;

    expect(chatSource).toContain("if (!slashToken) setDismissedSlashToken(\"\")");
    expect(chatSource).toContain("setDismissedSlashToken(\"\");\n              updateComposerSelection(event.target);");
    expect(chatSource).toContain("event.key === \"/\"");
    expect(chatSource).toContain("dismissedSlashToken === slashTokenKey");
  });
});

describe("slash command keyboard navigation", () => {
  it("accepts browser and platform arrow key names", () => {
    expect(slashCommandArrowDirection("ArrowDown")).toBe(1);
    expect(slashCommandArrowDirection("Down")).toBe(1);
    expect(slashCommandArrowDirection("ArrowUp")).toBe(-1);
    expect(slashCommandArrowDirection("Up")).toBe(-1);
    expect(slashCommandArrowDirection("Tab")).toBe(0);
  });
});

describe("composer model selection", () => {
  it("keeps the model selector available for idle existing sessions", () => {
    expect(shouldLockComposerModelSelection(false)).toBe(false);
    expect(shouldLockComposerModelSelection(true)).toBe(true);
  });

  it("starts existing sessions from their locked model until a session draft is selected", () => {
    const profileDraft = { provider: "openai-codex", model: "gpt-5.5" };
    const sessionModel = { provider: "openai-codex", model: "gpt-5.4" };
    const sessionDraft = { provider: "openai-codex", model: "gpt-5.4-mini" };

    expect(composerModelSelection(false, profileDraft, sessionModel)).toEqual(sessionModel);
    expect(composerModelSelection(false, profileDraft, sessionModel, sessionDraft)).toEqual(sessionDraft);
    expect(composerModelSelection(true, profileDraft, sessionModel, sessionDraft)).toEqual(profileDraft);
  });
});

describe("composer runtime notice", () => {
  it("stays hidden while runtime readiness is still checking", () => {
    expect(shouldShowRuntimeNotice(false, "")).toBe(false);
    expect(shouldShowRuntimeNotice(false, "Start Iris Core, then retry.")).toBe(true);
    expect(shouldShowRuntimeNotice(true, "")).toBe(false);
  });
});

describe("composer voice recording status", () => {
  it("keeps transient dictation states out of the visible toolbar layout", () => {
    expect(shouldShowVisibleDictationStatus({ status: "requesting-permission" })).toBe(false);
    expect(shouldShowVisibleDictationStatus({
      status: "recording",
      startedAt: 1,
      elapsedMs: 0,
      audioLevel: 0,
      audioLevels: [],
    })).toBe(false);
    expect(shouldShowVisibleDictationStatus({ status: "stopping", elapsedMs: 1000 })).toBe(false);
    expect(shouldShowVisibleDictationStatus({ status: "sending", elapsedMs: 1000 })).toBe(false);
  });

  it("shows visible dictation text only when the user needs an error message", () => {
    expect(shouldShowVisibleDictationStatus({ status: "error", message: "No microphone was found." })).toBe(true);
  });
});
