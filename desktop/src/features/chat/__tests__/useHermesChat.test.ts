import { describe, expect, it } from "vitest";
import type { Message } from "../../../app/types";
import type { HermesInboxMessage } from "../../../types/hermes";
import {
  coalescePostStreamAttachments,
  mergeCompletedDelivery,
  mergeConversationChatIdMap,
  mergeStreamDelivery,
  modelCommand,
  shouldApplyConversationDetailSelection,
  shouldPreserveLocalMessagesOnEmptyHistory,
  shouldPreserveProfileConversationSelection,
  shouldRetryUnmappedDelivery,
  shouldSendModelSwitch,
  shouldSkipConversationDetailLoad,
  stripModelSwitchNote,
  toAppMessages,
} from "../useHermesChat";

function inboxMessage(
  overrides: Partial<HermesInboxMessage> & { id: string; content: string },
): HermesInboxMessage {
  return {
    cursor: 1,
    source: "hermes-gateway-stream",
    platform: "agentui",
    profile: "default",
    chatId: "desktop-1",
    metadata: {},
    createdAt: 1,
    acknowledgedAt: null,
    ...overrides,
  };
}

describe("Hermes chat inbox merging", () => {
  it("keeps the chat-id map stable when a conversation refresh has no new mappings", () => {
    const current = { "conversation-1": "chat-1" };

    expect(
      mergeConversationChatIdMap(current, [
        { id: "conversation-1", chatId: "chat-1" },
        { id: "conversation-2", chatId: "" },
      ]),
    ).toBe(current);
  });

  it("caps retries for unmapped inbox deliveries so stale rows cannot refresh forever", () => {
    expect(shouldRetryUnmappedDelivery(0)).toBe(true);
    expect(shouldRetryUnmappedDelivery(1)).toBe(true);
    expect(shouldRetryUnmappedDelivery(2)).toBe(false);
  });

  it("replaces the optimistic assistant bubble with the first stream update", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1", content: "Starting" }),
      "stream-1",
      false,
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ]);
  });

  it("updates an existing streamed assistant bubble instead of appending duplicates", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "stream-1:edit:1", content: "Starting to answer." }),
      "stream-1",
      true,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "stream-1",
      content: "Starting to answer.",
      streaming: false,
      streamMessageId: "stream-1",
    });
  });

  it("matches later edits against the visible message id when an older sidecar generated the first id", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Write a long answer" },
      {
        id: "sidecar-row-1",
        role: "assistant",
        content: "Starting",
        streaming: true,
        streamMessageId: "adapter-planned-id",
      },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({ id: "sidecar-row-2", content: "Starting to answer." }),
      "sidecar-row-1",
      false,
    );

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      id: "sidecar-row-1",
      content: "Starting to answer.",
      streaming: true,
      streamMessageId: "sidecar-row-1",
    });
  });

  it("keeps non-stream deliveries on the completed-message path", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Ping" },
      { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "final-1", source: "hermes-gateway", content: "Pong" }),
      "user-1",
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "final-1",
        role: "assistant",
        content: "Pong",
        streaming: false,
      },
    ]);
  });

  it("replaces the active streaming assistant when a final delivery has no reply metadata", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      {
        id: "assistant-1",
        role: "assistant",
        content: "Thinking...",
        streaming: true,
        streamEvents: [
          {
            id: "tool-1",
            callId: "tool-1",
            toolName: "image_generate",
            label: "image_generate",
            status: "completed",
          },
        ],
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "final-1", source: "hermes-gateway", content: "Image: /tmp/hermes/test_image.png" }),
      "",
    );

    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        id: "final-1",
        content: "Image: /tmp/hermes/test_image.png",
        streaming: false,
      },
    ]);
  });

  it("attaches a post-stream media delivery to the completed streamed assistant", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Here’s your test image:",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({ id: "media-1", source: "hermes-gateway", content: "🖼️ Image: /tmp/hermes/test_image.png" }),
      "",
    );

    expect(merged).toEqual([
      existing[0],
      {
        ...existing[1],
        content: "Here’s your test image:\n\n🖼️ Image: /tmp/hermes/test_image.png",
      },
    ]);
  });

  it("ignores replayed completed text after a stream finalizes", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Hi" },
      {
        id: "stream-1",
        role: "assistant",
        content: "Hi! What can I help you with today?",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    const merged = mergeCompletedDelivery(
      existing,
      inboxMessage({
        id: "final-duplicate-1",
        source: "hermes-gateway",
        content: "Hi! What can I help you with today?",
      }),
      "user-1",
    );

    expect(merged).toEqual(existing);
  });

  it("shows a final stream plus file delivery provisionally until canonical history reloads", () => {
    const streamed = mergeStreamDelivery(
      [
        { id: "user-1", role: "user", content: "create a test image for me" },
        { id: "assistant-1", role: "assistant", content: "Thinking...", streaming: true },
      ],
      inboxMessage({
        id: "stream-1:edit:1",
        source: "hermes-gateway-stream",
        content: "I created a simple test image for you:\n\nNote: fallback SVG locally.",
      }),
      "stream-1",
      true,
    );

    const provisional = mergeCompletedDelivery(
      streamed,
      inboxMessage({ id: "media-1", source: "hermes-gateway", content: "📎 File: /tmp/test_image.svg" }),
      "",
    );
    const canonical = toAppMessages([
      {
        id: "user-1",
        sessionId: "session-1",
        role: "user",
        content: "create a test image for me",
        toolName: "",
        timestamp: 1,
      },
      {
        id: "assistant-canonical",
        sessionId: "session-1",
        role: "assistant",
        content: [
          "I created a simple test image for you:",
          "",
          "MEDIA:/tmp/test_image.svg",
          "",
          "Note: fallback SVG locally.",
        ].join("\n"),
        toolName: "",
        timestamp: 2,
      },
    ]);

    expect(provisional[1].content).toBe(
      "I created a simple test image for you:\n\nNote: fallback SVG locally.\n\n📎 File: /tmp/test_image.svg",
    );
    expect(canonical[1].content).toBe(
      "I created a simple test image for you:\n\nMEDIA:/tmp/test_image.svg\n\nNote: fallback SVG locally.",
    );
  });

  it("coalesces a media delivery that is replayed before the final stream row", () => {
    const existing: Message[] = [
      { id: "user-1", role: "user", content: "Create an image" },
      { id: "media-1", role: "assistant", content: "🖼️ Image: /tmp/hermes/test_image.png" },
    ];

    const merged = mergeStreamDelivery(
      existing,
      inboxMessage({
        id: "stream-1:edit:1",
        source: "hermes-gateway-stream",
        content: "Here’s your test image:",
      }),
      "stream-1",
      true,
    );

    expect(merged).toEqual([
      existing[0],
      {
        id: "stream-1",
        role: "assistant",
        content: "Here’s your test image:\n\n🖼️ Image: /tmp/hermes/test_image.png",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ]);
  });

  it("does not move normal prose that only mentions attachment labels", () => {
    const messages: Message[] = [
      { id: "user-1", role: "user", content: "Explain labels" },
      { id: "note-1", role: "assistant", content: "The File: label appears in gateway output." },
      {
        id: "stream-1",
        role: "assistant",
        content: "Here is the explanation.",
        streaming: false,
        streamMessageId: "stream-1",
      },
    ];

    expect(coalescePostStreamAttachments(messages)).toEqual(messages);
  });
});

describe("Hermes chat profile selection", () => {
  it("preserves an explicit conversation selection while switching profiles", () => {
    expect(
      shouldPreserveProfileConversationSelection("default", "cron-default", {
        profile: "default",
        conversationId: "cron-default",
      }),
    ).toBe(true);
  });

  it("does not preserve stale selections from another profile", () => {
    expect(
      shouldPreserveProfileConversationSelection("health", "cron-default", {
        profile: "default",
        conversationId: "cron-default",
      }),
    ).toBe(false);
    expect(shouldPreserveProfileConversationSelection("default", null, null)).toBe(false);
  });
});

describe("Hermes chat model switching", () => {
  it("sends a model switch only when the selected first-message model differs", () => {
    expect(
      shouldSendModelSwitch(
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.4" },
      ),
    ).toBe(true);
    expect(
      shouldSendModelSwitch(
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.5" },
      ),
    ).toBe(false);
    expect(shouldSendModelSwitch(null, { provider: "openai-codex", model: "gpt-5.5" })).toBe(false);
  });

  it("formats the hidden Hermes model command with provider scope", () => {
    expect(modelCommand({ provider: "openai-codex", model: "gpt-5.5" })).toBe(
      "/model gpt-5.5 --provider openai-codex",
    );
    expect(modelCommand({ provider: "", model: "local/model" })).toBe("/model local/model");
  });

  it("strips Hermes model switch adapter notes from rendered user messages", () => {
    expect(
      stripModelSwitchNote(
        "[Note: model was just switched from gpt-5.5 to gpt-5.4-mini via OpenAI Codex. Adjust your self-identification accordingly.] Reply exactly: model picker smoke",
      ),
    ).toBe("Reply exactly: model picker smoke");
  });
});

describe("Hermes chat conversation detail loading", () => {
  it("does not let empty canonical history erase a local failed first request", () => {
    expect(
      shouldPreserveLocalMessagesOnEmptyHistory(
        [
          { id: "user-1", role: "user", content: "Use unauthenticated model" },
          { id: "assistant-1", role: "assistant", content: "Could not resolve credentials", streaming: false },
        ],
        [],
      ),
    ).toBe(true);
  });

  it("accepts canonical history once Hermes has persisted messages", () => {
    expect(
      shouldPreserveLocalMessagesOnEmptyHistory(
        [{ id: "user-1", role: "user", content: "Hello" }],
        [
          {
            id: "history-user-1",
            sessionId: "session-1",
            role: "user",
            content: "Hello",
            toolName: "",
            timestamp: 1,
          },
        ],
      ),
    ).toBe(false);
  });

  it("does not let a stale detail response retake selection after another conversation was clicked", () => {
    expect(
      shouldApplyConversationDetailSelection(
        "conversation-b",
        "chat-b",
        "conversation-a",
        { id: "conversation-a", chatId: "chat-a" },
      ),
    ).toBe(false);
  });

  it("allows a current detail response to replace an alias with its loaded conversation id", () => {
    expect(
      shouldApplyConversationDetailSelection(
        "conversation-alias",
        "chat-a",
        "conversation-alias",
        { id: "conversation-a", chatId: "chat-a" },
      ),
    ).toBe(true);
  });

  it("reloads completed real conversations even when live messages are already cached", () => {
    expect(shouldSkipConversationDetailLoad("session-1", {})).toBe(false);
  });

  it("keeps active and optimistic conversations on provisional state", () => {
    expect(shouldSkipConversationDetailLoad("session-1", { "session-1": "request-1" })).toBe(true);
    expect(shouldSkipConversationDetailLoad("optimistic-1", {})).toBe(true);
  });
});
